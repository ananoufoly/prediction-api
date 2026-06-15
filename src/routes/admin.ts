import { Router } from 'express';
import { backfillOpenfootball } from '../ingestion/openfootball.js';
import { fetchAllEspnScores } from '../ingestion/espnScores.js';
import { backfillUnderstat } from '../ingestion/understat.js';
import { fetchAllSports } from '../ingestion/oddsApi.js';
import { ingestStandings } from '../ingestion/standings.js';

export const adminRouter = Router();

adminRouter.post('/admin/backfill/openfootball', async (_req, res) => {
  res.json({ started: true });
  backfillOpenfootball().catch((err) => console.error('[admin] openfootball backfill error:', err));
});

adminRouter.post('/admin/ingest/espn', async (_req, res) => {
  res.json({ started: true });
  fetchAllEspnScores().catch((err) => console.error('[admin] espn ingest error:', err));
});

adminRouter.post('/admin/ingest/understat', async (_req, res) => {
  res.json({ started: true });
  backfillUnderstat(2024).catch((err) => console.error('[admin] understat ingest error:', err));
});

adminRouter.post('/admin/ingest/odds', async (_req, res) => {
  res.json({ started: true });
  fetchAllSports().catch((err) => console.error('[admin] odds ingest error:', err));
});

adminRouter.post('/admin/ingest/standings', async (_req, res) => {
  res.json({ started: true });
  ingestStandings().catch((err) => console.error('[admin] standings ingest error:', err));
});
