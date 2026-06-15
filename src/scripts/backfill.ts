import { backfillOpenfootball } from '../ingestion/openfootball.js';
import { prisma } from '../db.js';

async function main() {
  await backfillOpenfootball();
  const count = await prisma.match.count({ where: { status: 'FINAL', homeGoals: { not: null } } });
  console.log(`\nFinished matches with goals in DB: ${count}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
