import { prisma } from '../../db.js';
import { trainModels } from '../model/train.js';
import { trainIntl } from '../model/intl.js';

/**
 * Train prediction models and report validation metrics.
 *   npx tsx --env-file=.env src/prediction/scripts/trainModels.ts [sport ...]
 * With no args, trains all club sports + the two international models.
 */
async function main() {
  const requested = process.argv.slice(2);
  const clubReq = requested.filter((s) => s !== 'football_intl' && s !== 'rugby_intl');
  const intlReq = requested.filter((s) => s === 'football_intl' || s === 'rugby_intl');

  const results = requested.length
    ? (clubReq.length ? await trainModels(clubReq) : [])
    : await trainModels();
  const intlResults = requested.length
    ? (intlReq.length ? await trainIntl(intlReq[0]) : [])
    : await trainIntl();

  console.log('\n=== VALIDATION METRICS (temporal last-10% holdout) ===');
  console.log('sport          model              train   val   accuracy   brier');
  for (const r of [...results, ...intlResults]) {
    if (!r.ok) { console.log(`${r.sport.padEnd(14)} FAILED: ${r.note}`); continue; }
    const acc = r.valAccuracy != null ? (r.valAccuracy * 100).toFixed(1) + '%' : 'n/a';
    const brier = r.valBrier != null ? r.valBrier.toFixed(4) : 'n/a';
    const modelType = 'modelType' in r ? (r as { modelType?: string }).modelType ?? '' : 'logistic_weighted';
    console.log(
      `${r.sport.padEnd(14)} ${modelType.padEnd(18)} ${String(r.trainRows).padEnd(7)} ${String(r.valRows).padEnd(5)} ${acc.padEnd(10)} ${brier}`,
    );
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
