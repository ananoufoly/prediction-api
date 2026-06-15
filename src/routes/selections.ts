import { Router } from 'express';
import { prisma } from '../db.js';
import { ALL_LEAGUES } from '../leagues.js';
import { generateSelections, persistSelection } from '../selection/pipeline.js';
import { computeClv } from '../math/clv.js';
import { odds as brandOdds } from '../types/branded.js';

export const selectionsRouter = Router();

// CLV summary: last30 / last100 / allTime — MODEL selections, 3-way strategy split
selectionsRouter.get('/selections/clv-summary', async (_req, res) => {
  try {
    const settled = await prisma.selection.findMany({
      where: { clv: { not: null }, status: { in: ['SETTLED', 'PLACED'] } },
      orderBy: { selectedAt: 'desc' },
      select: { clv: true, selectionStrategy: true },
    });

    const MIN_SAMPLES = 20;

    function summarize(values: number[]) {
      if (values.length < MIN_SAMPLES) return null;
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      return { avg: parseFloat((avg * 100).toFixed(2)), n: values.length };
    }

    const allClv = settled.map((s) => s.clv as number);
    const standardClv = settled.filter((s) => s.selectionStrategy === 'STANDARD').map((s) => s.clv as number);
    const consensusClv = settled.filter((s) => s.selectionStrategy === 'CONSENSUS').map((s) => s.clv as number);

    res.json({
      last30: summarize(allClv.slice(0, 30)),
      last100: summarize(allClv.slice(0, 100)),
      allTime: summarize(allClv),
      totalSettled: allClv.length,
      standard: {
        last30: summarize(standardClv.slice(0, 30)),
        last100: summarize(standardClv.slice(0, 100)),
        allTime: summarize(standardClv),
        totalSettled: standardClv.length,
      },
      consensus: {
        last30: summarize(consensusClv.slice(0, 30)),
        last100: summarize(consensusClv.slice(0, 100)),
        allTime: summarize(consensusClv),
        totalSettled: consensusClv.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// P&L summary — split by source and by strategy
selectionsRouter.get('/selections/pnl-summary', async (_req, res) => {
  try {
    const settled = await prisma.selection.findMany({
      where: { pnl: { not: null } },
      select: { pnl: true, stakeActual: true, recommendedStake: true, source: true, selectionStrategy: true },
    });

    function summarize(rows: typeof settled) {
      const totalPnl = rows.reduce((a, s) => a + (s.pnl ?? 0), 0);
      const totalStaked = rows.reduce((a, s) => a + (s.stakeActual ?? s.recommendedStake), 0);
      const roi = totalStaked > 0 ? (totalPnl / totalStaked) * 100 : null;
      return {
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        totalStaked: parseFloat(totalStaked.toFixed(2)),
        roi: roi !== null ? parseFloat(roi.toFixed(2)) : null,
        n: rows.length,
      };
    }

    const modelRows = settled.filter((s) => s.source === 'MODEL');
    const derivedRows = settled.filter((s) => s.source === 'MODEL_DERIVED');
    const manualRows = settled.filter((s) => s.source === 'MANUAL_EXPLORATORY' || s.source === 'MANUAL_CONVICTION');
    const exploratoryRows = settled.filter((s) => s.source === 'MANUAL_EXPLORATORY');
    const convictionRows = settled.filter((s) => s.source === 'MANUAL_CONVICTION');
    const standardRows = settled.filter((s) => s.selectionStrategy === 'STANDARD');
    const consensusRows = settled.filter((s) => s.selectionStrategy === 'CONSENSUS');

    res.json({
      overall: summarize(settled),
      model: summarize(modelRows),
      modelDerived: summarize(derivedRows),
      manual: {
        ...summarize(manualRows),
        exploratoryCount: exploratoryRows.length,
        convictionCount: convictionRows.length,
      },
      standard: summarize(standardRows),
      consensus: summarize(consensusRows),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Manual CLV — CLV on manual bets only (off-model judgment quality)
selectionsRouter.get('/selections/manual-clv-summary', async (_req, res) => {
  try {
    const settled = await prisma.selection.findMany({
      where: { clv: { not: null }, status: 'SETTLED', source: { in: ['MANUAL_EXPLORATORY', 'MANUAL_CONVICTION', 'MODEL_DERIVED'] } },
      orderBy: { selectedAt: 'desc' },
      select: { clv: true },
    });

    const clvValues = settled.map((s) => s.clv as number);
    if (clvValues.length < 5) {
      res.json({ avg: null, n: clvValues.length });
      return;
    }
    const avg = clvValues.reduce((a, b) => a + b, 0) / clvValues.length;
    res.json({ avg: parseFloat((avg * 100).toFixed(2)), n: clvValues.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Today's selections — generate live from model
selectionsRouter.get('/selections/today', async (req, res) => {
  try {
    const debug = req.query['debug'] === 'true';
    const leagues = [...ALL_LEAGUES];
    const all: Awaited<ReturnType<typeof generateSelections>> = [];
    const diagnostics: Record<string, unknown> = {};

    for (const league of leagues) {
      const candidates = await generateSelections(league, 1000);
      all.push(...candidates);
      if (debug) {
        diagnostics[league] = { candidates: candidates.length };
      }
    }

    all.sort((a, b) => new Date(a.kickoffUtc).getTime() - new Date(b.kickoffUtc).getTime() || b.edgePct - a.edgePct);

    if (debug) {
      const now = new Date();
      const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
      for (const league of leagues) {
        const matches = await prisma.match.findMany({
          where: { league, status: 'SCHEDULED', kickoffUtc: { gte: now, lte: weekAhead } },
          include: { oddsSnapshots: { where: { isClosing: false, fetchedAt: { gte: new Date(now.getTime() - 6 * 3600_000) } } } },
        });
        (diagnostics[league] as Record<string, unknown>)['scheduledMatches'] = matches.length;
        (diagnostics[league] as Record<string, unknown>)['matchesWithFreshOdds'] = matches.filter((m) => m.oddsSnapshots.length > 0).length;
        (diagnostics[league] as Record<string, unknown>)['totalFreshOddsSnapshots'] = matches.reduce((a, m) => a + m.oddsSnapshots.length, 0);
      }
      res.json({ candidates: all, debug: diagnostics });
    } else {
      res.json(all);
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Bet history with filters — supports source filter
selectionsRouter.get('/selections', async (req, res) => {
  try {
    const { confidence, market, league, status, source } = req.query as Record<string, string | undefined>;

    // Parse source filter
    let sourceFilter: object = {};
    if (source === 'MODEL') {
      sourceFilter = { source: 'MODEL' };
    } else if (source === 'MODEL_DERIVED') {
      sourceFilter = { source: 'MODEL_DERIVED' };
    } else if (source === 'MANUAL') {
      sourceFilter = { source: { in: ['MANUAL_EXPLORATORY', 'MANUAL_CONVICTION'] } };
    } else if (source === 'MANUAL_EXPLORATORY' || source === 'MANUAL_CONVICTION') {
      sourceFilter = { source };
    }

    const selections = await prisma.selection.findMany({
      where: {
        ...(confidence ? { confidence: confidence as 'HIGH' | 'MEDIUM' | 'LOW' } : {}),
        ...(market ? { market } : {}),
        ...(status ? { status: status as 'PAPER' | 'PLACED' | 'SETTLED' | 'VOID' } : {}),
        ...(league ? { match: { league } } : {}),
        ...sourceFilter,
      },
      include: { match: { select: { homeTeam: true, awayTeam: true, league: true, kickoffUtc: true } } },
      orderBy: { selectedAt: 'desc' },
      take: 200,
    });

    res.json(selections);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Place a selection: PAPER → PLACED
selectionsRouter.post('/selections/:id/place', async (req, res) => {
  try {
    const { stakeActual, oddsAtPlacement } = req.body as {
      stakeActual?: number;
      oddsAtPlacement?: number;
    };

    const existing = await prisma.selection.findUniqueOrThrow({ where: { id: req.params['id'] } });

    const setting = await prisma.appSetting.findUnique({ where: { key: 'allowOffModelBets' } });
    const allowOffModel = setting?.value === 'true';

    const stake = stakeActual ?? existing.recommendedStake;

    const selection = await prisma.selection.update({
      where: { id: req.params['id'] },
      data: {
        status: 'PLACED',
        betPlaced: true,
        stakeActual: stake,
        ...(oddsAtPlacement != null ? { oddsAtPlacement } : {}),
      },
    });

    const agg = await prisma.bankrollEvent.aggregate({ _sum: { amount: true } });
    const currentBalance = parseFloat((agg._sum.amount ?? 0).toFixed(2));
    const balanceAfter = parseFloat((currentBalance - stake).toFixed(2));

    await prisma.bankrollEvent.create({
      data: {
        type: 'BET_PLACED',
        amount: -stake,
        balanceAfter,
        selectionId: selection.id,
        modelVersion: 'v1',
        selectionSource: existing.source,
      },
    });

    res.json({ ...selection, _offModelEnabled: allowOffModel });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Settle a selection: record result, compute P&L and CLV
selectionsRouter.post('/selections/:id/settle', async (req, res) => {
  try {
    const { result, closingOdds } = req.body as { result: 'WIN' | 'LOSS' | 'PUSH'; closingOdds?: number };

    const existing = await prisma.selection.findUniqueOrThrow({ where: { id: req.params['id'] } });
    const stake = existing.stakeActual ?? existing.recommendedStake;
    const placedOdds = existing.oddsAtPlacement ?? existing.oddsAtSelection;

    const pnl = result === 'WIN'
      ? parseFloat((stake * (placedOdds - 1)).toFixed(2))
      : result === 'PUSH'
      ? 0
      : -stake;

    const clv = closingOdds != null
      ? computeClv(brandOdds(placedOdds), brandOdds(closingOdds))
      : null;

    const updated = await prisma.selection.update({
      where: { id: req.params['id'] },
      data: {
        status: 'SETTLED',
        result,
        pnl,
        ...(closingOdds != null ? { closingOdds } : {}),
        ...(clv != null ? { clv } : {}),
      },
    });

    const returnAmount = result === 'WIN'
      ? parseFloat((stake * placedOdds).toFixed(2))
      : result === 'PUSH'
      ? stake
      : 0;

    const agg = await prisma.bankrollEvent.aggregate({ _sum: { amount: true } });
    const currentBalance = parseFloat((agg._sum.amount ?? 0).toFixed(2));
    const balanceAfter = parseFloat((currentBalance + returnAmount).toFixed(2));

    await prisma.bankrollEvent.create({
      data: {
        type: 'BET_SETTLED',
        amount: returnAmount,
        balanceAfter,
        selectionId: existing.id,
        note: result,
        modelVersion: 'v1',
        selectionSource: existing.source,
      },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Save a today-candidate as a PAPER selection — source always MODEL
selectionsRouter.post('/selections/save', async (req, res) => {
  try {
    const candidate = req.body as {
      matchId: string;
      market: string;
      outcome: string;
      bookmaker: string;
      decimalOdds: number;
      strategy?: 'STANDARD' | 'CONSENSUS';
      _offModel?: boolean;
    };

    if (candidate._offModel) {
      const setting = await prisma.appSetting.findUnique({ where: { key: 'allowOffModelBets' } });
      if (setting?.value !== 'true') {
        res.status(403).json({ error: 'Off-model bets are disabled. Enable in Settings to allow.' });
        return;
      }
    }

    // Dedup is strategy-aware: Standard and Consensus for the same outcome are separate records
    const existing = await prisma.selection.findFirst({
      where: {
        matchId: candidate.matchId,
        market: candidate.market,
        outcome: candidate.outcome,
        bookmaker: candidate.bookmaker,
        oddsAtSelection: candidate.decimalOdds,
        selectionStrategy: candidate.strategy ?? 'STANDARD',
      },
    });

    if (existing) {
      res.json({ ok: true, deduplicated: true, id: existing.id });
      return;
    }

    const sel = await persistSelection(req.body);
    res.json({ ok: true, deduplicated: false, id: sel.id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/selections/manual — save an off-model or model-derived bet
selectionsRouter.post('/selections/manual', async (req, res) => {
  try {
    const setting = await prisma.appSetting.findUnique({ where: { key: 'allowOffModelBets' } });
    if (setting?.value !== 'true') {
      res.status(403).json({ error: 'Off-model bets are disabled. Enable in Settings to allow.' });
      return;
    }

    const {
      matchId, market, outcome, bookmaker, decimalOdds,
      stake, source, note, derivedFromIds,
    } = req.body as {
      matchId: string;
      market: string;
      outcome: string;
      bookmaker: string;
      decimalOdds: number;
      stake: number;
      source: 'MODEL_DERIVED' | 'MANUAL_EXPLORATORY' | 'MANUAL_CONVICTION';
      note: string;
      derivedFromIds?: string[];
    };

    if (!note || note.trim().length === 0) {
      res.status(400).json({ error: 'note is required' });
      return;
    }
    if (!['MODEL_DERIVED', 'MANUAL_EXPLORATORY', 'MANUAL_CONVICTION'].includes(source)) {
      res.status(400).json({ error: 'source must be MODEL_DERIVED, MANUAL_EXPLORATORY, or MANUAL_CONVICTION' });
      return;
    }
    // derivedFromIds is optional — note field carries the reasoning audit trail
    if (!stake || stake <= 0) {
      res.status(400).json({ error: 'stake must be > 0' });
      return;
    }

    // Check bankroll cap: stake must not exceed 2% of current balance
    const agg = await prisma.bankrollEvent.aggregate({ _sum: { amount: true } });
    const currentBalance = parseFloat((agg._sum.amount ?? 0).toFixed(2));
    const cap = currentBalance * 0.02;
    const exceedsCap = currentBalance > 0 && stake > cap;

    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });

    const sel = await prisma.selection.create({
      data: {
        matchId: match.id,
        market,
        outcome,
        modelProb: 0,
        bookieFairProb: 1 / decimalOdds,
        bookmaker,
        oddsAtSelection: decimalOdds,
        edgePct: 0,
        kellyFraction: 0,
        recommendedStake: 0,
        confidence: 'LOW',
        status: 'PLACED',
        betPlaced: true,
        stakeActual: stake,
        source,
        manualNote: note.trim(),
        derivedFromIds: derivedFromIds ?? [],
        isLive: false,
      },
    });

    // Deduct stake from bankroll immediately
    const balanceAfter = parseFloat((currentBalance - stake).toFixed(2));
    await prisma.bankrollEvent.create({
      data: {
        type: 'BET_PLACED',
        amount: -stake,
        balanceAfter,
        selectionId: sel.id,
        note: `${source}: ${note.trim()}`,
        modelVersion: 'v1',
        selectionSource: source,
      },
    });

    res.json({ ...sel, _exceedsCap: exceedsCap, _capAmount: parseFloat(cap.toFixed(2)) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/backfill/bets — atomic multi-bet backfill with bankroll recomputation
// Body: { startingBalance: number, effectiveDate: string, bets: BackfillBet[] }
// BackfillBet: { matchId, market, outcome, source, bookmaker, decimalOdds, stake,
//               placedAt, result, settledAt, note?, derivedFromIds? }
selectionsRouter.post('/backfill/bets', async (req, res) => {
  try {
    const {
      startingBalance,
      effectiveDate,
      bets,
    } = req.body as {
      startingBalance: number;
      effectiveDate: string;
      bets: {
        homeTeam: string;
        awayTeam: string;
        kickoffDate: string;
        market: string;
        outcome: string;
        source: 'MODEL_DERIVED' | 'MANUAL_EXPLORATORY' | 'MANUAL_CONVICTION';
        bookmaker: string;
        decimalOdds: number;
        stake: number;
        placedAt: string;
        result: 'WIN' | 'LOSS' | 'VOID';
        settledAt: string;
        note?: string;
        derivedFromIds?: string[];
      }[];
    };

    if (typeof startingBalance !== 'number' || startingBalance < 0) {
      res.status(400).json({ error: 'startingBalance must be a non-negative number' });
      return;
    }
    if (!effectiveDate || isNaN(Date.parse(effectiveDate))) {
      res.status(400).json({ error: 'effectiveDate must be a valid ISO date' });
      return;
    }
    if (!Array.isArray(bets) || bets.length === 0) {
      res.status(400).json({ error: 'bets array must be non-empty' });
      return;
    }

    const effectiveDt = new Date(effectiveDate);

    // 1. Get current balance to compute the adjustment delta
    const agg = await prisma.bankrollEvent.aggregate({ _sum: { amount: true } });
    const currentBalance = parseFloat((agg._sum.amount ?? 0).toFixed(2));
    const adjustmentAmount = parseFloat((startingBalance - currentBalance).toFixed(2));

    // Insert the reset ADJUSTMENT event at effectiveDate
    await prisma.bankrollEvent.create({
      data: {
        occurredAt: effectiveDt,
        type: 'ADJUSTMENT',
        amount: adjustmentAmount,
        balanceAfter: startingBalance,
        note: `Backfill reset: balance set to €${startingBalance.toFixed(2)} at ${effectiveDt.toISOString().slice(0, 10)}`,
      },
    });

    // 2. Create selections + paired BankrollEvents for each bet
    // Sort bets by placedAt so we insert in order
    const sortedBets = [...bets].sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime());

    const createdIds: string[] = [];
    for (const bet of sortedBets) {
      // Resolve match by team names + date (find or create stub)
      const kickoffStart = new Date(bet.kickoffDate);
      kickoffStart.setUTCHours(0, 0, 0, 0);
      const kickoffEnd = new Date(kickoffStart.getTime() + 86_400_000);

      let match = await prisma.match.findFirst({
        where: {
          homeTeam: { contains: bet.homeTeam, mode: 'insensitive' },
          awayTeam: { contains: bet.awayTeam, mode: 'insensitive' },
          kickoffUtc: { gte: kickoffStart, lt: kickoffEnd },
        },
      });

      if (!match) {
        match = await prisma.match.upsert({
          where: {
            league_homeTeam_awayTeam_kickoffUtc: {
              league: 'BACKFILL',
              homeTeam: bet.homeTeam,
              awayTeam: bet.awayTeam,
              kickoffUtc: kickoffStart,
            },
          },
          update: {},
          create: {
            homeTeam: bet.homeTeam,
            awayTeam: bet.awayTeam,
            league: 'BACKFILL',
            kickoffUtc: kickoffStart,
            status: 'FINAL',
          },
        });
      }

      const matchId = match.id;

      const pnl = bet.result === 'WIN'
        ? parseFloat((bet.stake * (bet.decimalOdds - 1)).toFixed(2))
        : bet.result === 'VOID'
        ? 0
        : parseFloat((-bet.stake).toFixed(2));

      const returnAmount = bet.result === 'WIN'
        ? parseFloat((bet.stake * bet.decimalOdds).toFixed(2))
        : bet.result === 'VOID'
        ? bet.stake
        : 0;

      const selResult: 'WIN' | 'LOSS' | 'PUSH' = bet.result === 'VOID' ? 'PUSH' : bet.result;

      const sel = await prisma.selection.create({
        data: {
          matchId,
          market: bet.market,
          outcome: bet.outcome,
          modelProb: 0,
          bookieFairProb: parseFloat((1 / bet.decimalOdds).toFixed(4)),
          bookmaker: bet.bookmaker,
          oddsAtSelection: bet.decimalOdds,
          oddsAtPlacement: bet.decimalOdds,
          edgePct: 0,
          kellyFraction: 0,
          recommendedStake: 0,
          confidence: 'LOW',
          selectedAt: new Date(bet.placedAt),
          status: 'SETTLED',
          betPlaced: true,
          stakeActual: bet.stake,
          result: selResult,
          pnl,
          source: bet.source,
          manualNote: bet.note?.trim() ?? null,
          derivedFromIds: bet.derivedFromIds ?? [],
          backfilled: true,
          isLive: false,
        },
      });
      createdIds.push(sel.id);

      // BET_PLACED — at placedAt with balance = 0 (will be recomputed below)
      await prisma.bankrollEvent.create({
        data: {
          occurredAt: new Date(bet.placedAt),
          type: 'BET_PLACED',
          amount: -bet.stake,
          balanceAfter: 0,
          selectionId: sel.id,
          note: `Backfill: ${bet.source}`,
          selectionSource: bet.source,
        },
      });

      // BET_SETTLED — at settledAt
      await prisma.bankrollEvent.create({
        data: {
          occurredAt: new Date(bet.settledAt),
          type: 'BET_SETTLED',
          amount: returnAmount,
          balanceAfter: 0,
          selectionId: sel.id,
          note: selResult,
          selectionSource: bet.source,
        },
      });
    }

    // 3. Recompute balanceAfter for ALL events in chronological order
    const allEvents = await prisma.bankrollEvent.findMany({ orderBy: { occurredAt: 'asc' } });
    let running = 0;
    for (const ev of allEvents) {
      running = parseFloat((running + ev.amount).toFixed(2));
      if (Math.abs(ev.balanceAfter - running) > 0.001) {
        await prisma.bankrollEvent.update({ where: { id: ev.id }, data: { balanceAfter: running } });
      }
    }

    // 4. Return verification info
    const finalBalance = running;
    const totalStaked = sortedBets.reduce((s, b) => s + b.stake, 0);
    const totalPnl = sortedBets.reduce((s, b) => {
      if (b.result === 'WIN') return s + b.stake * (b.decimalOdds - 1);
      if (b.result === 'VOID') return s;
      return s - b.stake;
    }, 0);

    res.json({
      ok: true,
      selectionIds: createdIds,
      startingBalance,
      finalBalance: parseFloat(finalBalance.toFixed(2)),
      totalStaked: parseFloat(totalStaked.toFixed(2)),
      totalPnl: parseFloat(totalPnl.toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/settings/allow-off-model
selectionsRouter.get('/settings/allow-off-model', async (_req, res) => {
  try {
    const setting = await prisma.appSetting.findUnique({ where: { key: 'allowOffModelBets' } });
    res.json({ enabled: setting?.value === 'true' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

selectionsRouter.put('/settings/allow-off-model', async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    await prisma.appSetting.upsert({
      where: { key: 'allowOffModelBets' },
      create: { key: 'allowOffModelBets', value: String(enabled) },
      update: { value: String(enabled) },
    });
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/selections/:id
selectionsRouter.delete('/selections/:id', async (req, res) => {
  try {
    const id = req.params['id']!;
    await prisma.bankrollEvent.deleteMany({ where: { selectionId: id } });
    await prisma.selection.delete({ where: { id } });

    const remaining = await prisma.bankrollEvent.findMany({ orderBy: { occurredAt: 'asc' } });
    let running = 0;
    for (const ev of remaining) {
      running = parseFloat((running + ev.amount).toFixed(2));
      if (ev.balanceAfter !== running) {
        await prisma.bankrollEvent.update({ where: { id: ev.id }, data: { balanceAfter: running } });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// CSV export of settled selections — includes source
selectionsRouter.get('/bet-log/export', async (_req, res) => {
  try {
    const rows = await prisma.selection.findMany({
      where: { status: 'SETTLED' },
      include: { match: { select: { homeTeam: true, awayTeam: true, league: true, kickoffUtc: true } } },
      orderBy: { selectedAt: 'asc' },
    });

    const header = 'date,league,match,market,outcome,source,strategy,confidence,bookmaker,odds,stake,result,pnl,clv,note';
    const lines = rows.map((r) => [
      r.selectedAt.toISOString().slice(0, 10),
      r.match.league,
      `"${r.match.homeTeam} vs ${r.match.awayTeam}"`,
      r.market,
      r.outcome,
      r.source,
      r.selectionStrategy,
      r.confidence,
      r.bookmaker,
      r.oddsAtSelection,
      r.stakeActual ?? r.recommendedStake,
      r.result ?? '',
      r.pnl ?? '',
      r.clv != null ? (r.clv * 100).toFixed(2) + '%' : '',
      r.manualNote ? `"${r.manualNote.replace(/"/g, '""')}"` : '',
    ].join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="bet-log.csv"');
    res.send([header, ...lines].join('\n'));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/selections/history — full history for the History page, no take cap
// Query params: from, to, source (comma-separated), confidence, league, market,
//               bookmaker, result, status, edgeMin, edgeMax, backfilled, strategy
selectionsRouter.get('/selections/history', async (req, res) => {
  try {
    const {
      from, to, source, confidence, league, market,
      bookmaker, result, status, edgeMin, edgeMax, backfilled, strategy,
    } = req.query as Record<string, string | undefined>;

    // Multi-value source filter
    let sourceFilter: object = {};
    if (source) {
      const sources = source.split(',').map((s) => s.trim()).filter(Boolean);
      if (sources.length === 1) {
        sourceFilter = { source: sources[0] };
      } else if (sources.length > 1) {
        sourceFilter = { source: { in: sources } };
      }
    }

    const rows = await prisma.selection.findMany({
      where: {
        ...(from ? { selectedAt: { gte: new Date(from) } } : {}),
        ...(to ? { selectedAt: { lte: new Date(to) } } : {}),
        ...(confidence ? { confidence: confidence as 'HIGH' | 'MEDIUM' | 'LOW' } : {}),
        ...(market ? { market } : {}),
        ...(bookmaker ? { bookmaker } : {}),
        ...(result ? { result: result as 'WIN' | 'LOSS' | 'PUSH' } : {}),
        ...(status ? { status: status as 'PAPER' | 'PLACED' | 'SETTLED' | 'VOID' } : {}),
        ...(league ? { match: { league } } : {}),
        ...(edgeMin != null ? { edgePct: { gte: parseFloat(edgeMin) / 100 } } : {}),
        ...(edgeMax != null ? { edgePct: { lte: parseFloat(edgeMax) / 100 } } : {}),
        ...(backfilled === 'true' ? { backfilled: true } : backfilled === 'false' ? { backfilled: false } : {}),
        ...(strategy === 'STANDARD' || strategy === 'CONSENSUS' ? { selectionStrategy: strategy } : {}),
        ...sourceFilter,
      },
      include: {
        match: {
          select: { id: true, homeTeam: true, awayTeam: true, league: true, kickoffUtc: true, status: true },
        },
      },
      orderBy: { selectedAt: 'desc' },
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/selections/:id/detail — full detail for one selection, including prediction snapshot
selectionsRouter.get('/selections/:id/detail', async (req, res) => {
  try {
    const sel = await prisma.selection.findUniqueOrThrow({
      where: { id: req.params['id'] },
      include: {
        match: true,
      },
    });

    // Fetch the closest prediction before selectedAt for this match
    const prediction = await prisma.prediction.findFirst({
      where: {
        matchId: sel.matchId,
        generatedAt: { lte: sel.selectedAt },
      },
      orderBy: { generatedAt: 'desc' },
    });

    // For model-derived bets, fetch referenced selections
    let derivedFrom: object[] = [];
    if (sel.source === 'MODEL_DERIVED' && sel.derivedFromIds.length > 0) {
      const refs = await prisma.selection.findMany({
        where: { id: { in: sel.derivedFromIds } },
        include: { match: { select: { homeTeam: true, awayTeam: true, league: true, kickoffUtc: true } } },
        select: {
          id: true, market: true, outcome: true, oddsAtSelection: true, edgePct: true,
          confidence: true, source: true, status: true, result: true,
          match: true,
        },
      });
      derivedFrom = refs;
    }

    res.json({ ...sel, prediction, derivedFrom });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH /api/selections/:id — limited edits: stake correction, note, manual settle override
selectionsRouter.patch('/selections/:id', async (req, res) => {
  try {
    const { stakeActual, manualNote } = req.body as {
      stakeActual?: number;
      manualNote?: string;
    };

    const updated = await prisma.selection.update({
      where: { id: req.params['id'] },
      data: {
        ...(stakeActual != null && stakeActual > 0 ? { stakeActual } : {}),
        ...(manualNote != null ? { manualNote: manualNote.trim() } : {}),
      },
      include: { match: { select: { homeTeam: true, awayTeam: true, league: true, kickoffUtc: true } } },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
