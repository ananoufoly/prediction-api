import { prisma } from '../../db.js';
import { predictAll, predictSport } from '../model/predict.js';
import { predictIntl } from '../model/intl.js';

/**
 * Generate prediction objects from the trained models.
 *   npx tsx --env-file=.env src/prediction/scripts/predict.ts [sport ...]
 * With no args, predicts all club sports + the international models.
 */
async function main() {
  const requested = process.argv.slice(2);
  if (requested.length) {
    for (const sport of requested) {
      if (sport === 'football_intl' || sport === 'rugby_intl') {
        const c = await predictIntl(sport);
        console.log(`[predict] ${sport}: ${c[sport] ?? 0} predictions`);
      } else {
        const preds = await predictSport(sport);
        console.log(`[predict] ${sport}: ${preds.length} predictions`);
      }
    }
  } else {
    const counts = await predictAll();
    const intlCounts = await predictIntl();
    console.log('[predict] counts:', JSON.stringify({ ...counts, ...intlCounts }));
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
