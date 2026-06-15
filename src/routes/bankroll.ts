import { Router } from 'express';
import { prisma } from '../db.js';

export const bankrollRouter = Router();

// Derive current balance from sum of all events
async function currentBalance(): Promise<number> {
  const agg = await prisma.bankrollEvent.aggregate({ _sum: { amount: true } });
  return parseFloat((agg._sum.amount ?? 0).toFixed(2));
}

// GET /api/bankroll — current balance + recent events
bankrollRouter.get('/bankroll', async (req, res) => {
  try {
    const { from, to, type, limit } = req.query as Record<string, string | undefined>;

    const events = await prisma.bankrollEvent.findMany({
      where: {
        ...(from ? { occurredAt: { gte: new Date(from) } } : {}),
        ...(to ? { occurredAt: { lte: new Date(to) } } : {}),
        ...(type ? { type: type as 'DEPOSIT' | 'WITHDRAWAL' | 'BET_PLACED' | 'BET_SETTLED' | 'ADJUSTMENT' } : {}),
      },
      orderBy: { occurredAt: 'asc' },
      take: limit ? parseInt(limit) : 500,
    });

    const balance = await currentBalance();

    res.json({ balance, events });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/bankroll/manual — DEPOSIT / WITHDRAWAL / ADJUSTMENT (note required)
bankrollRouter.post('/bankroll/manual', async (req, res) => {
  try {
    const { type, amount, note } = req.body as {
      type: 'DEPOSIT' | 'WITHDRAWAL' | 'ADJUSTMENT';
      amount: number;
      note: string;
    };

    if (!['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT'].includes(type)) {
      res.status(400).json({ error: 'type must be DEPOSIT, WITHDRAWAL or ADJUSTMENT' });
      return;
    }
    if (!note || note.trim().length === 0) {
      res.status(400).json({ error: 'note is required for manual events' });
      return;
    }
    if (typeof amount !== 'number' || isNaN(amount) || amount === 0) {
      res.status(400).json({ error: 'amount must be a non-zero number' });
      return;
    }

    const balance = await currentBalance();
    const signed = type === 'WITHDRAWAL' ? -Math.abs(amount) : type === 'DEPOSIT' ? Math.abs(amount) : amount;
    const balanceAfter = parseFloat((balance + signed).toFixed(2));

    const event = await prisma.bankrollEvent.create({
      data: { type, amount: signed, balanceAfter, note: note.trim(), modelVersion: 'v1' },
    });

    res.json(event);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/bankroll/backfill — generate retroactive events from settled selections
bankrollRouter.post('/bankroll/backfill', async (_req, res) => {
  try {
    // Skip if events already exist (idempotent guard)
    const existing = await prisma.bankrollEvent.count();
    if (existing > 0) {
      res.json({ skipped: true, reason: 'events already exist', count: existing });
      return;
    }

    // Get all PLACED or SETTLED selections in chronological order
    const selections = await prisma.selection.findMany({
      where: { status: { in: ['PLACED', 'SETTLED'] } },
      orderBy: { selectedAt: 'asc' },
    });

    let runningBalance = 0;
    const events = [];

    for (const sel of selections) {
      const stake = sel.stakeActual ?? sel.recommendedStake;
      const odds = sel.oddsAtPlacement ?? sel.oddsAtSelection;

      // BET_PLACED: deduct stake
      runningBalance = parseFloat((runningBalance - stake).toFixed(2));
      events.push({
        occurredAt: sel.selectedAt,
        type: 'BET_PLACED' as const,
        amount: -stake,
        balanceAfter: runningBalance,
        selectionId: sel.id,
        modelVersion: 'v1',
      });

      // BET_SETTLED: add return if settled
      if (sel.status === 'SETTLED' && sel.result != null) {
        const returnAmount = sel.result === 'WIN'
          ? parseFloat((stake * odds).toFixed(2))
          : sel.result === 'PUSH'
          ? stake
          : 0;

        // For LOSS, settled later with +0 (stake already deducted)
        const settleOccurredAt = new Date(sel.selectedAt.getTime() + 2 * 60_000); // 2min after
        runningBalance = parseFloat((runningBalance + returnAmount).toFixed(2));
        events.push({
          occurredAt: settleOccurredAt,
          type: 'BET_SETTLED' as const,
          amount: returnAmount,
          balanceAfter: runningBalance,
          selectionId: sel.id,
          note: sel.result,
          modelVersion: 'v1',
        });
      }
    }

    if (events.length > 0) {
      await prisma.bankrollEvent.createMany({ data: events });
    }

    res.json({ ok: true, created: events.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
