import { prisma } from '../../db.js';
import { computeIntlFootballFeatures, computeIntlRugbyFeatures } from '../features/intl.js';
import { trainIntl, predictIntl } from '../model/intl.js';

async function main() {
  console.log('[intl] computing features...');
  await computeIntlFootballFeatures();
  await computeIntlRugbyFeatures();

  console.log('[intl] training models...');
  const results = await trainIntl();
  console.log('\n=== INTL MODEL VALIDATION (temporal last-10% holdout) ===');
  for (const r of results) {
    if (!r.ok) { console.log(`${r.sport}: FAILED ${r.note}`); continue; }
    const acc = r.valAccuracy != null ? (r.valAccuracy * 100).toFixed(1) + '%' : 'n/a';
    console.log(`${r.sport.padEnd(14)} train=${r.trainRows} val=${r.valRows} acc=${acc} brier=${r.valBrier?.toFixed(4)}`);
  }

  console.log('\n[intl] generating predictions...');
  const counts = await predictIntl();

  const now = new Date();
  console.log('\n=== INTL ROW COUNTS ===');
  console.log('intl_football_fixtures:', await prisma.intlFootballFixture.count());
  console.log('intl_football_elo:', await prisma.intlFootballElo.count());
  console.log('intl_rugby_fixtures:', await prisma.intlRugbyFixture.count());
  console.log('intl_rugby_elo:', await prisma.intlRugbyElo.count());
  console.log('\n=== INTL UPCOMING PREDICTIONS ===');
  for (const sport of ['football_intl', 'rugby_intl']) {
    const total = await prisma.enginePrediction.count({ where: { sport, kickoffUtc: { gte: now } } });
    const real = await prisma.enginePrediction.count({ where: { sport, kickoffUtc: { gte: now }, predictedOutcome: { not: null } } });
    console.log(`  ${sport}: predicted=${counts[sport] ?? 0} | upcoming=${total} (real=${real})`);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
