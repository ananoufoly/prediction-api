import { Router } from 'express';
import { prisma } from '../db.js';
import { getMonthlyUsage } from '../ingestion/budget.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

healthRouter.get('/budget', async (_req, res) => {
  try {
    const { used, remaining, hardCap } = await getMonthlyUsage('odds-api');
    const month = new Date().toISOString().slice(0, 7);
    res.json({
      provider: 'odds-api',
      month,
      used,
      remaining,
      hardCap,
      note: remaining < 50 ? '⚠️ Budget low — fetches will pause at 0' : 'Budget tracking live',
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
