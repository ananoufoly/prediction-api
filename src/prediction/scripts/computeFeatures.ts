import { prisma } from '../../db.js';
import { FEATURE_BUILDERS } from '../features/index.js';

/**
 * Compute features for one or more sports.
 *   npx tsx --env-file=.env src/prediction/scripts/computeFeatures.ts [sport ...]
 * With no args, runs every sport.
 */
async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length ? requested : Object.keys(FEATURE_BUILDERS);

  for (const sport of targets) {
    const fn = FEATURE_BUILDERS[sport];
    if (!fn) { console.error(`[features] unknown sport "${sport}"`); continue; }
    console.log(`[features] computing ${sport}...`);
    const t0 = Date.now();
    await fn();
    const n = await prisma.predictionFeature.count({ where: { sport } });
    console.log(`[features] ${sport}: ${n} rows in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
