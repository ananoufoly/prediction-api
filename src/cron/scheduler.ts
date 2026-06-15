import cron from 'node-cron';
import { fetchAllSports } from '../ingestion/oddsApi.js';
import { fetchAllEspnScores } from '../ingestion/espnScores.js';
import { backfillUnderstat } from '../ingestion/understat.js';
import { captureClosingSnapshots } from '../ingestion/closingSnapshot.js';
import { ingestStandings } from '../ingestion/standings.js';

function wrap(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err) => console.error(`[cron:${name}] error:`, err));
  };
}

export function startCronJobs(): void {
  // Odds: every 2 hours (12 runs/day × 26 leagues = ~312 req/day, ~9,360/month under 20k budget)
  cron.schedule('0 */2 * * *', wrap('odds', fetchAllSports));

  // ESPN scores: every 5 minutes (free, no budget concern)
  cron.schedule('*/5 * * * *', wrap('espn', fetchAllEspnScores));

  // Closing snapshot: every minute, per-match, only for T-5min matches with active selections
  cron.schedule('* * * * *', wrap('closing', captureClosingSnapshots));

  // Understat xG: daily at 3am (scrape, be polite)
  cron.schedule('0 3 * * *', wrap('understat', () => backfillUnderstat(2024)));

  // League standings: daily at 4am — 100 req/day limit, ~10 leagues = fine
  cron.schedule('0 4 * * *', wrap('standings', ingestStandings));

  console.log('[cron] Jobs scheduled: odds(2h), espn(5m), closing(1m), understat(3am), standings(4am)');
}
