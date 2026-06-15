import { prisma } from '../db.js';
async function main() {
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86400000);
  const upcoming = await prisma.match.findMany({
    where: { status: 'SCHEDULED', kickoffUtc: { gte: now, lte: weekAhead } },
    select: { league: true, homeTeam: true, awayTeam: true, kickoffUtc: true },
    orderBy: { kickoffUtc: 'asc' },
  });
  console.log(`Upcoming fixtures (next 7 days): ${upcoming.length}`);
  for (const m of upcoming.slice(0, 10)) {
    console.log(` ${m.league.padEnd(15)} ${m.homeTeam} vs ${m.awayTeam} — ${m.kickoffUtc.toISOString().slice(0,10)}`);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
