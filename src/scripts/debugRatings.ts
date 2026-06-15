import { computeXgRatings } from '../model/xgRatings.js';
import { prisma } from '../db.js';

async function main() {
  const lr = await computeXgRatings('EPL');
  const teams = [...lr.teams.values()].sort((a, b) => b.attack - a.attack);
  console.log('Top team:', teams[0]);
  console.log('Bottom team:', teams[teams.length - 1]);
  console.log('Mid team:', teams[Math.floor(teams.length / 2)]);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
