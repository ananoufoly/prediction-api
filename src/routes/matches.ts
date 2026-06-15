import { Router } from 'express';
import { prisma } from '../db.js';
import { computeXgRatings } from '../model/xgRatings.js';
import { applyEloPriors } from '../model/elo.js';
import { computeMatchProbsDC, fitRho, type TrainingMatch } from '../model/dixonColes.js';
import { expectedGoals } from '../model/poisson.js';
import { shinDevig } from '../math/shin.js';
import { computeEdge } from '../selection/edge.js';
import { normalizeTeam } from '../ingestion/teamNorm.js';
import { prob } from '../types/branded.js';
import { ALL_LEAGUES } from '../leagues.js';
import { getLeagueStandings } from '../ingestion/standings.js';
import { evaluateMatchMotivation, type MotivationFlag } from '../model/motivation.js';

export const matchesRouter = Router();

const COLD_THRESHOLD = 0.05;

export interface MatchMarketData {
  market: string;
  outcome: string;
  modelProb: number;
  bookieFairProb: number | null;
  bestOdds: number | null;
  bestBookmaker: string | null;
  edgePct: number | null;
  passesThreshold: boolean;
  oddsStale: boolean;
}

export interface MatchBrowseItem {
  matchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  lambdaHome: number;
  lambdaAway: number;
  markets: MatchMarketData[];
  maxEdge: number | null;
  wouldBet: boolean;
  hasOdds: boolean;
  oddsAge: number | null;
  motivationHome: MotivationFlag;
  motivationAway: MotivationFlag;
  motivationReason: string;
}

// GET /api/matches/browse?sort=kickoff|maxEdge|league&league=EPL
matchesRouter.get('/matches/browse', async (req, res) => {
  try {
    const { sort = 'kickoff', league: leagueFilter } = req.query as Record<string, string | undefined>;
    const leagues = leagueFilter ? [leagueFilter] : [...ALL_LEAGUES];

    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
    const sixHAgo = new Date(now.getTime() - 6 * 3600_000);

    // Pre-load all PAPER selections to determine "would bet" badge
    const paperSelections = await prisma.selection.findMany({
      where: { status: 'PAPER' },
      select: { matchId: true, market: true, outcome: true },
    });
    const paperKeys = new Set(paperSelections.map((s) => `${s.matchId}:${s.market}:${s.outcome}`));

    const result: MatchBrowseItem[] = [];

    for (const lg of leagues) {
      let lr: Awaited<ReturnType<typeof computeXgRatings>>;
      try {
        lr = await computeXgRatings(lg);
        await applyEloPriors(lg, lr.teams);
      } catch { continue; }

      // Standings for motivation flags
      const standings = await getLeagueStandings(lg).catch(() => new Map());

      // Fit rho
      const recent = await prisma.match.findMany({
        where: { league: lg, status: 'FINAL', homeGoals: { not: null } },
        orderBy: { kickoffUtc: 'desc' },
        take: 500,
      });
      const training: TrainingMatch[] = [];
      for (const m of recent) {
        const h = lr.teams.get(m.homeTeam) ?? lr.teams.get(normalizeTeam(m.homeTeam));
        const a = lr.teams.get(m.awayTeam) ?? lr.teams.get(normalizeTeam(m.awayTeam));
        if (!h || !a) continue;
        const eg = expectedGoals(h.attack, h.defense, a.attack, a.defense, lr.leagueAvgAttack, undefined, lr.goalConversionFactor);
        training.push({ lambdaHome: eg.lambdaHome, lambdaAway: eg.lambdaAway, homeGoals: m.homeGoals!, awayGoals: m.awayGoals! });
      }
      const rho = training.length >= 50 ? fitRho(training).rho : -0.1;

      // Fetch all matches — include ALL snapshots (not filtered by freshness)
      const matches = await prisma.match.findMany({
        where: { league: lg, status: 'SCHEDULED', kickoffUtc: { gte: now, lte: weekAhead } },
        include: {
          oddsSnapshots: {
            where: { isClosing: false },
            orderBy: { fetchedAt: 'desc' },
          },
        },
        orderBy: { kickoffUtc: 'asc' },
      });

      for (const match of matches) {
        const leagueAvg = { team: 'avg', attack: 1.0, defense: 1.0, games: 0 };
        const homeRating = lr.teams.get(match.homeTeam) ?? lr.teams.get(normalizeTeam(match.homeTeam)) ?? leagueAvg;
        const awayRating = lr.teams.get(match.awayTeam) ?? lr.teams.get(normalizeTeam(match.awayTeam)) ?? leagueAvg;

        const { lambdaHome, lambdaAway } = expectedGoals(
          homeRating.attack, homeRating.defense,
          awayRating.attack, awayRating.defense,
          lr.leagueAvgAttack, undefined, lr.goalConversionFactor,
        );

        const probs = computeMatchProbsDC(
          homeRating.attack, homeRating.defense,
          awayRating.attack, awayRating.defense,
          lr.leagueAvgAttack, rho, undefined, lr.goalConversionFactor,
        );

        const homeNorm = normalizeTeam(match.homeTeam);
        const awayNorm = normalizeTeam(match.awayTeam);

        const modelProbByOutcome: Record<string, number> = {
          [match.homeTeam]: probs.pHome, [homeNorm]: probs.pHome,
          'Draw': probs.pDraw,
          [match.awayTeam]: probs.pAway, [awayNorm]: probs.pAway,
          'Over 2.5': probs.pOver25, 'Under 2.5': 1 - probs.pOver25,
          'BTTS Yes': probs.pBtts, 'BTTS No': 1 - probs.pBtts,
        };

        // Most recent odds fetch timestamp for this match
        const latestSnap = match.oddsSnapshots[0];
        const oddsAge = latestSnap
          ? Math.round((now.getTime() - latestSnap.fetchedAt.getTime()) / 60_000)
          : null;
        const hasOdds = match.oddsSnapshots.length > 0;
        const oddsStale = oddsAge !== null && oddsAge > 360; // >6h

        // Best odds per outcome (from most recent snapshots)
        type BestEntry = { odds: number; bookmaker: string; bookieFairProb: number };
        const bestByOutcome = new Map<string, BestEntry>();

        // Only use snapshots from latest batch (within 10min of most recent)
        const freshCutoff = latestSnap
          ? new Date(latestSnap.fetchedAt.getTime() - 10 * 60_000)
          : null;
        const recentSnaps = freshCutoff
          ? match.oddsSnapshots.filter((s) => s.fetchedAt >= freshCutoff)
          : [];

        // Group by market → bookmaker for devig
        const snapsByMarket = new Map<string, typeof recentSnaps>();
        for (const snap of recentSnaps) {
          if (!snapsByMarket.has(snap.market)) snapsByMarket.set(snap.market, []);
          snapsByMarket.get(snap.market)!.push(snap);
        }

        for (const [, snaps] of snapsByMarket) {
          const byBookie = new Map<string, typeof snaps>();
          for (const s of snaps) {
            if (!byBookie.has(s.bookmaker)) byBookie.set(s.bookmaker, []);
            byBookie.get(s.bookmaker)!.push(s);
          }
          for (const [, rawBookSnaps] of byBookie) {
            // Deduplicate to latest per outcome (snaps ordered desc by fetchedAt)
            const seenOutcome = new Map<string, typeof rawBookSnaps[number]>();
            for (const s of rawBookSnaps) {
              if (!seenOutcome.has(s.outcome)) seenOutcome.set(s.outcome, s);
            }
            const bookSnaps = [...seenOutcome.values()];
            let fairMap: Map<string, number>;
            try {
              const shin = shinDevig(bookSnaps.map((s) => s.decimalOdds));
              fairMap = new Map(bookSnaps.map((s, i) => [s.outcome, shin.probabilities[i] ?? (1 / s.decimalOdds)]));
            } catch {
              fairMap = new Map(bookSnaps.map((s) => [s.outcome, 1 / s.decimalOdds]));
            }
            for (const snap of bookSnaps) {
              const fair = fairMap.get(snap.outcome) ?? (1 / snap.decimalOdds);
              const existing = bestByOutcome.get(snap.outcome);
              if (!existing || snap.decimalOdds > existing.odds) {
                bestByOutcome.set(snap.outcome, { odds: snap.decimalOdds, bookmaker: snap.bookmaker, bookieFairProb: fair });
              }
            }
          }
        }

        const MARKET_OUTCOMES: Record<string, string[]> = {
          h2h: [match.homeTeam, 'Draw', match.awayTeam],
          totals: ['Over 2.5', 'Under 2.5'],
          btts: ['BTTS Yes', 'BTTS No'],
        };

        const markets: MatchMarketData[] = [];

        for (const [mkt, outcomes] of Object.entries(MARKET_OUTCOMES)) {
          for (const outcome of outcomes) {
            const modelProb = modelProbByOutcome[outcome] ?? modelProbByOutcome[normalizeTeam(outcome)];
            if (modelProb === undefined) continue;

            const best = bestByOutcome.get(outcome);
            if (!best) {
              // No odds available — show model prob only
              markets.push({
                market: mkt, outcome, modelProb,
                bookieFairProb: null, bestOdds: null, bestBookmaker: null,
                edgePct: null, passesThreshold: false, oddsStale,
              });
              continue;
            }

            const edge = computeEdge(prob(modelProb), prob(best.bookieFairProb));
            markets.push({
              market: mkt, outcome, modelProb,
              bookieFairProb: best.bookieFairProb,
              bestOdds: best.odds, bestBookmaker: best.bookmaker,
              edgePct: edge, passesThreshold: edge >= COLD_THRESHOLD && !oddsStale,
              oddsStale,
            });
          }
        }

        const edgeValues = markets.map((m) => m.edgePct).filter((e): e is number => e !== null);
        const maxEdge = edgeValues.length > 0 ? Math.max(...edgeValues) : null;
        const wouldBet = markets.some((m) => paperKeys.has(`${match.id}:${m.market}:${m.outcome}`));

        const homeKey = standings.has(match.homeTeam) ? match.homeTeam : normalizeTeam(match.homeTeam);
        const awayKey = standings.has(match.awayTeam) ? match.awayTeam : normalizeTeam(match.awayTeam);
        const motivation = evaluateMatchMotivation(homeKey, awayKey, standings);

        result.push({
          matchId: match.id,
          league: match.league,
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          kickoffUtc: match.kickoffUtc.toISOString(),
          lambdaHome, lambdaAway,
          markets,
          maxEdge,
          wouldBet,
          hasOdds,
          oddsAge,
          motivationHome: motivation.home.flag,
          motivationAway: motivation.away.flag,
          motivationReason: motivation.reason,
        });
      }
    }

    if (sort === 'maxEdge') result.sort((a, b) => (b.maxEdge ?? -99) - (a.maxEdge ?? -99));
    else if (sort === 'league') result.sort((a, b) => a.league.localeCompare(b.league) || a.kickoffUtc.localeCompare(b.kickoffUtc));
    else result.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/matches/search?q=Everton — full-text search across all matches (any status, any date)
// Used by the backfill flow to find historical matches not returned by /matches/browse
matchesRouter.get('/matches/search', async (req, res) => {
  try {
    const q = (req.query['q'] as string | undefined)?.trim() ?? '';
    if (q.length < 2) { res.json([]); return; }

    const matches = await prisma.match.findMany({
      where: {
        OR: [
          { homeTeam: { contains: q, mode: 'insensitive' } },
          { awayTeam: { contains: q, mode: 'insensitive' } },
          { league:   { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, homeTeam: true, awayTeam: true, league: true, kickoffUtc: true, status: true },
      orderBy: { kickoffUtc: 'desc' },
      take: 20,
    });

    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/matches/:matchId/scores — score probability breakdown for a single match
matchesRouter.get('/matches/:matchId/scores', async (req, res) => {
  try {
    const { matchId } = req.params;

    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) { res.status(404).json({ error: 'Match not found' }); return; }

    // Compute ratings for this match's league
    let lr: Awaited<ReturnType<typeof computeXgRatings>>;
    try {
      lr = await computeXgRatings(match.league);
      await applyEloPriors(match.league, lr.teams);
    } catch {
      res.status(422).json({ error: 'No model data for this league yet' }); return;
    }

    const leagueAvg = { team: 'avg', attack: 1.0, defense: 1.0, games: 0 };
    const homeRating = lr.teams.get(match.homeTeam) ?? lr.teams.get(normalizeTeam(match.homeTeam)) ?? leagueAvg;
    const awayRating = lr.teams.get(match.awayTeam) ?? lr.teams.get(normalizeTeam(match.awayTeam)) ?? leagueAvg;

    const { lambdaHome, lambdaAway } = expectedGoals(
      homeRating.attack, homeRating.defense,
      awayRating.attack, awayRating.defense,
      lr.leagueAvgAttack, undefined, lr.goalConversionFactor,
    );

    // Build score matrix (0-6 goals each for display)
    const { buildScoreMatrix, matchProbsFromMatrix } = await import('../model/poisson.js');
    const sm = buildScoreMatrix(lambdaHome, lambdaAway);
    const probs = matchProbsFromMatrix(sm);

    // Top scores
    const MAX_DISPLAY = 6;
    type ScoreEntry = { home: number; away: number; prob: number };
    const scores: ScoreEntry[] = [];
    for (let h = 0; h <= MAX_DISPLAY; h++) {
      for (let a = 0; a <= MAX_DISPLAY; a++) {
        scores.push({ home: h, away: a, prob: sm.matrix[h]![a]! });
      }
    }
    scores.sort((a, b) => b.prob - a.prob);
    const topScores = scores.slice(0, 8);

    // Over/Under for multiple lines
    const lines = [1.5, 2.5, 3.5, 4.5];
    const ouLines = lines.map((line) => {
      let pOver = 0;
      for (let h = 0; h <= MAX_DISPLAY; h++) {
        for (let a = 0; a <= MAX_DISPLAY; a++) {
          if (h + a > line) pOver += sm.matrix[h]![a]!;
        }
      }
      return { line, pOver, pUnder: 1 - pOver };
    });

    // Clean sheets
    let pHomeCleanSheet = 0, pAwayCleanSheet = 0;
    for (let h = 0; h <= MAX_DISPLAY; h++) {
      pHomeCleanSheet += sm.matrix[h]![0]!;       // away scores 0
      pAwayCleanSheet += sm.matrix[0]![h]!;       // home scores 0
    }

    res.json({
      matchId,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      league: match.league,
      kickoffUtc: match.kickoffUtc,
      lambdaHome,
      lambdaAway,
      pHome: probs.pHome,
      pDraw: probs.pDraw,
      pAway: probs.pAway,
      pBtts: probs.pBtts,
      pHomeCleanSheet,
      pAwayCleanSheet,
      topScores,
      ouLines,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
