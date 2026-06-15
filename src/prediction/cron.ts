import cron from 'node-cron';
import { ingestApiFootball } from './ingestion/apiFootball.js';
import { ingestOpenfootballHistory } from './ingestion/openfootballHistory.js';
import { ingestTennisSackmann } from './ingestion/tennisSackmann.js';
import { ingestRugby } from './ingestion/rugbyEspn.js';
import { ingestNba } from './ingestion/nba.js';
import { ingestNfl } from './ingestion/nfl.js';
import { ingestMlb } from './ingestion/mlb.js';
import {
  computeFootballFeatures, computeTennisFeatures, computeBasketballFeatures,
  computeNflFeatures, computeBaseballFeatures, computeRugbyFeatures,
} from './features/index.js';
import { trainModels } from './model/train.js';
import { predictAll } from './model/predict.js';
import { ingestUpcomingFootball } from './ingestion/upcomingFootball.js';
import { ingestUpcomingMlb } from './ingestion/upcomingMlb.js';
import { ingestUpcomingNba } from './ingestion/upcomingNba.js';
import { ingestUpcomingNfl } from './ingestion/upcomingNfl.js';
import { ingestIntlFootball } from './ingestion/intlFootball.js';
import { ingestIntlRugby } from './ingestion/intlRugby.js';
import { computeIntlFootballFeatures, computeIntlRugbyFeatures } from './features/intl.js';
import { trainIntl, predictIntl } from './model/intl.js';

/**
 * Prediction-engine ingestion schedule. Kept SEPARATE from the edge model's
 * cron (src/cron/scheduler.ts). None of these providers touch The Odds API
 * quota. Times are staggered into the early-morning window, away from the
 * edge model's odds(2h)/espn(5m)/closing(1m) jobs.
 */

function wrap(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err) => console.error(`[pred-cron:${name}] error:`, err));
  };
}

export function startPredictionCron(): void {
  // API-Football: daily 02:10 — budget-gated internally (100 req/day, enriches
  // a bounded batch of fixtures with lineups/injuries each run).
  cron.schedule('10 2 * * *', wrap('api_football', () => ingestApiFootball()));

  // OpenFootball history top-up: weekly (Mon 02:30) — only current season changes.
  cron.schedule('30 2 * * 1', wrap('openfootball', () => ingestOpenfootballHistory({ seasons: ['2025-26', '2024-25'] })));

  // Tennis incremental: daily 02:40 — re-pull current year only (idempotent upsert).
  cron.schedule('40 2 * * *', wrap('tennis', () => {
    const y = new Date().getUTCFullYear();
    return ingestTennisSackmann({ fromYear: y, toYear: y });
  }));

  // Rugby: daily 03:10 — ESPN free, sparse data.
  cron.schedule('10 3 * * *', wrap('rugby', () => ingestRugby()));

  // NBA: daily 03:30 (current + last 3 seasons; in-season this refreshes results).
  cron.schedule('30 3 * * *', wrap('nba', () => ingestNba()));

  // NFL: daily 03:50 (2020→latest; weekly cadence in practice, cheap to re-run).
  cron.schedule('50 3 * * *', wrap('nfl', () => ingestNfl()));

  // MLB: daily 04:10 (2020→latest; StatsAPI, FanGraphs stats unavailable).
  cron.schedule('10 4 * * *', wrap('mlb', () => ingestMlb()));

  // Phase 2: feature computation, after all ingestion has run for the night.
  // Each builder recomputes from raw tables and upserts prediction_features.
  cron.schedule('30 4 * * *', wrap('features', async () => {
    await computeFootballFeatures();
    await computeTennisFeatures();
    await computeBasketballFeatures();
    await computeNflFeatures();      // includes open-meteo weather lookups
    await computeBaseballFeatures();
    await computeRugbyFeatures();
  }));

  // Phase 3: weekly retrain (Mon 05:00, after Mon feature refresh) on all
  // available history, then regenerate predictions for every match.
  cron.schedule('0 5 * * 1', wrap('retrain', async () => {
    const results = await trainModels();
    for (const r of results) {
      console.log(`[pred-cron:retrain] ${r.sport}: ok=${r.ok} acc=${r.valAccuracy ?? 'n/a'} brier=${r.valBrier ?? 'n/a'}${r.ok ? '' : ' note=' + r.note}`);
    }
    const counts = await predictAll();
    console.log('[pred-cron:retrain] predictions regenerated:', JSON.stringify(counts));
  }));

  // Phase 4: daily prediction refresh (05:30) using the current artifacts so new
  // fixtures/feature updates get fresh prediction objects without retraining.
  cron.schedule('30 5 * * *', wrap('predict', async () => {
    const counts = await predictAll();
    console.log('[pred-cron:predict] predictions generated:', JSON.stringify(counts));
  }));

  // Upcoming club fixtures (ESPN/StatsAPI/nfl) refreshed daily at 05:50, then
  // features + predictions regenerated for the affected sports.
  cron.schedule('50 5 * * *', wrap('upcoming', async () => {
    await ingestUpcomingFootball({ forwardDays: 28 }).catch((e) => console.error('[upcoming] football', e.message));
    await ingestUpcomingMlb({ forwardDays: 14 }).catch((e) => console.error('[upcoming] mlb', e.message));
    await ingestUpcomingNba({ forwardDays: 14 }).catch((e) => console.error('[upcoming] nba', e.message));
    await ingestUpcomingNfl().catch((e) => console.error('[upcoming] nfl', e.message));
    await Promise.all([
      computeFootballFeatures(), computeBaseballFeatures(), computeBasketballFeatures(), computeNflFeatures(),
    ]).catch((e) => console.error('[upcoming] features', e.message));
    const counts = await predictAll();
    console.log('[pred-cron:upcoming] regenerated:', JSON.stringify(counts));
  }));

  // International module (football + rugby): own data → features → predict.
  // Daily at 06:10; weekly retrain folded into Monday via the same job checking dow.
  cron.schedule('10 6 * * *', wrap('intl', async () => {
    await ingestIntlFootball().catch((e) => console.error('[intl] football', e.message));
    await ingestIntlRugby().catch((e) => console.error('[intl] rugby', e.message));
    await computeIntlFootballFeatures().catch((e) => console.error('[intl] fb features', e.message));
    await computeIntlRugbyFeatures().catch((e) => console.error('[intl] rug features', e.message));
    // Retrain weekly (Monday); predict every day.
    if (new Date().getUTCDay() === 1) {
      const r = await trainIntl();
      console.log('[pred-cron:intl] retrained:', r.map((x) => `${x.sport} acc=${x.valAccuracy}`).join(', '));
    }
    const counts = await predictIntl();
    console.log('[pred-cron:intl] predictions:', JSON.stringify(counts));
  }));

  console.log('[pred-cron] Prediction-engine jobs scheduled: api_football(2:10), openfootball(Mon 2:30), tennis(2:40), rugby(3:10), nba(3:30), nfl(3:50), mlb(4:10), features(4:30), retrain(Mon 5:00), predict(5:30), upcoming(5:50), intl(6:10)');
}
