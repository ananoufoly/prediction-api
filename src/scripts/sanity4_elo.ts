import { computeXgRatings } from '../model/xgRatings.js';
import { computeEloRatings, applyEloPriors, eloToRatingProxy } from '../model/elo.js';
import { prisma } from '../db.js';

async function main() {
  const league = 'EPL';

  const eloRatings = await computeEloRatings(league);
  const sorted = [...eloRatings.values()].sort((a, b) => b.elo - a.elo);
  const avgElo = sorted.reduce((s, r) => s + r.elo, 0) / sorted.length;

  console.log(`\nEPL Elo ratings (avg=${avgElo.toFixed(0)}):`);
  console.log('Top 5:');
  for (const r of sorted.slice(0, 5)) {
    const proxy = eloToRatingProxy(r.elo, avgElo);
    console.log(`  ${r.team.padEnd(35)} elo=${r.elo.toFixed(0)}  atk_proxy=${proxy.attack.toFixed(3)}  def_proxy=${proxy.defense.toFixed(3)}  (${r.games}g)`);
  }
  console.log('Bottom 5:');
  for (const r of sorted.slice(-5).reverse()) {
    const proxy = eloToRatingProxy(r.elo, avgElo);
    console.log(`  ${r.team.padEnd(35)} elo=${r.elo.toFixed(0)}  atk_proxy=${proxy.attack.toFixed(3)}  def_proxy=${proxy.defense.toFixed(3)}  (${r.games}g)`);
  }

  // Test: apply priors to xG ratings and check low-data teams get sensible priors
  const lr = await computeXgRatings(league);
  const lowDataBefore = [...lr.teams.values()].filter((t) => t.games < 5);
  console.log(`\nLow-data teams before prior (games < 5): ${lowDataBefore.length}`);
  for (const t of lowDataBefore) {
    console.log(`  ${t.team}: atk=${t.attack.toFixed(3)} def=${t.defense.toFixed(3)} (${t.games}g) — currently at league avg`);
  }

  await applyEloPriors(league, lr.teams);

  console.log('\nAfter Elo prior:');
  for (const t of lowDataBefore) {
    const updated = lr.teams.get(t.team);
    if (updated) {
      console.log(`  ${t.team}: atk=${updated.attack.toFixed(3)} def=${updated.defense.toFixed(3)} (${updated.games}g)`);
    }
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
