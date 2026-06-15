import { prisma } from '../../db.js';
import { ingestUpcomingFootball } from '../ingestion/upcomingFootball.js';
import { ingestUpcomingMlb } from '../ingestion/upcomingMlb.js';
import { ingestUpcomingNba } from '../ingestion/upcomingNba.js';
import { ingestUpcomingNfl } from '../ingestion/upcomingNfl.js';
import { ingestRugby } from '../ingestion/rugbyEspn.js';
import { FEATURE_BUILDERS } from '../features/index.js';
import { predictSport } from '../model/predict.js';

/**
 * Full upcoming pipeline: ingest forward fixtures → recompute features →
 * regenerate predictions, for every sport. Uses existing trained artifacts.
 */
async function main() {
  const only = process.argv.slice(2);
  const want = (s: string) => only.length === 0 || only.includes(s);

  if (want('football')) await ingestUpcomingFootball({ forwardDays: 28 }).catch((e) => console.error('football upcoming:', e.message));
  if (want('mlb')) await ingestUpcomingMlb({ forwardDays: 14 }).catch((e) => console.error('mlb upcoming:', e.message));
  if (want('nba')) await ingestUpcomingNba({ forwardDays: 14 }).catch((e) => console.error('nba upcoming:', e.message));
  if (want('nfl')) await ingestUpcomingNfl().catch((e) => console.error('nfl upcoming:', e.message));
  if (want('rugby')) await ingestRugby().catch((e) => console.error('rugby upcoming:', e.message));

  for (const sport of ['football', 'mlb', 'nba', 'nfl', 'rugby']) {
    if (!want(sport)) continue;
    await FEATURE_BUILDERS[sport]!().catch((e) => console.error(`features ${sport}:`, e.message));
    await predictSport(sport).catch((e) => console.error(`predict ${sport}:`, e.message));
  }

  const now = new Date();
  console.log('\n=== UPCOMING PREDICTIONS PER SPORT ===');
  for (const sport of ['football', 'tennis', 'nba', 'nfl', 'mlb', 'rugby']) {
    const total = await prisma.enginePrediction.count({ where: { sport, kickoffUtc: { gte: now } } });
    const real = await prisma.enginePrediction.count({ where: { sport, kickoffUtc: { gte: now }, predictedOutcome: { not: null } } });
    console.log(`  ${sport.padEnd(9)} upcoming=${String(total).padEnd(4)} withPrediction=${real}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
