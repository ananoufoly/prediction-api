import { computeAllLeagueRatings } from '../model/xgRatings.js';
import { prisma } from '../db.js';

async function main() {
  const allRatings = await computeAllLeagueRatings();

  for (const [league, lr] of allRatings) {
    const teams = [...lr.teams.values()].filter((t) => t.games >= 3);
    if (teams.length < 3) {
      console.log(`\n${league}: only ${teams.length} teams with ≥3 games — skipping`);
      continue;
    }

    const byAttack = teams.sort((a, b) => b.attack - a.attack);
    const top5 = byAttack.slice(0, 5);
    const bot5 = byAttack.slice(-5).reverse();

    console.log(`\n─── ${league} (${teams.length} teams, avg attack=${lr.leagueAvgAttack.toFixed(3)} goals/game) ───`);
    console.log('  Top 5 attack:');
    for (const t of top5) {
      console.log(`    ${t.team.padEnd(30)} atk=${t.attack.toFixed(3)}  def=${t.defense.toFixed(3)}  (${t.games}g)`);
    }
    console.log('  Bottom 5 attack:');
    for (const t of bot5) {
      console.log(`    ${t.team.padEnd(30)} atk=${t.attack.toFixed(3)}  def=${t.defense.toFixed(3)}  (${t.games}g)`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
