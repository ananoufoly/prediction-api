import { fetchAllSports } from '../ingestion/oddsApi.js';
import { prisma } from '../db.js';

async function main() {
  await fetchAllSports();

  const snapshots = await prisma.oddsSnapshot.count();
  const recent = await prisma.oddsSnapshot.findMany({
    orderBy: { fetchedAt: 'desc' },
    take: 5,
    include: { match: { select: { homeTeam: true, awayTeam: true, league: true } } },
  });

  console.log(`\nTotal snapshots in DB: ${snapshots}`);
  for (const s of recent) {
    console.log(`  ${s.match.league}: ${s.match.homeTeam} vs ${s.match.awayTeam} | ${s.bookmaker} ${s.market} ${s.outcome} @${s.decimalOdds}`);
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
