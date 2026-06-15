import { prisma } from '../db.js';
import { computeXgRatings } from '../model/xgRatings.js';
import { expectedGoals } from '../model/poisson.js';

async function main() {
  const league = 'Serie A';

  const matches = await prisma.match.findMany({
    where: { league, status: 'FINAL', homeGoals: { not: null } },
    orderBy: { kickoffUtc: 'asc' },
  });

  // 1. Empirical over-2.5 rate
  const over25 = matches.filter((m) => m.homeGoals! + m.awayGoals! > 2.5).length;
  console.log(`\n[1] Empirical over 2.5 rate: ${(over25 / matches.length * 100).toFixed(1)}% (${over25}/${matches.length})`);

  // Compare with EPL
  const eplMatches = await prisma.match.findMany({
    where: { league: 'EPL', status: 'FINAL', homeGoals: { not: null } },
  });
  const eplOver25 = eplMatches.filter((m) => m.homeGoals! + m.awayGoals! > 2.5).length;
  console.log(`[1] EPL empirical over 2.5 rate: ${(eplOver25 / eplMatches.length * 100).toFixed(1)}%`);

  // 2. xG vs actual goals comparison
  const withXg = matches.filter((m) => m.homeXg !== null && m.awayXg !== null);
  if (withXg.length > 0) {
    const avgXg = withXg.reduce((s, m) => s + m.homeXg! + m.awayXg!, 0) / withXg.length;
    const avgGoals = withXg.reduce((s, m) => s + m.homeGoals! + m.awayGoals!, 0) / withXg.length;
    console.log(`\n[2] xG vs goals (${withXg.length} matches with xG):`);
    console.log(`    Avg total xG: ${avgXg.toFixed(3)}  Avg total goals: ${avgGoals.toFixed(3)}`);
    console.log(`    Conversion ratio: ${(avgGoals / avgXg).toFixed(3)}`);
  } else {
    const avgGoals = matches.reduce((s, m) => s + m.homeGoals! + m.awayGoals!, 0) / matches.length;
    console.log(`\n[2] No xG data. Avg total goals: ${avgGoals.toFixed(3)}`);
  }

  // 3. Check λ distribution for Serie A vs EPL
  const lr = await computeXgRatings(league);
  const lrEpl = await computeXgRatings('EPL');

  let sumLambda = 0, countLambda = 0;
  for (const m of matches.slice(0, 100)) {
    const home = lr.teams.get(m.homeTeam);
    const away = lr.teams.get(m.awayTeam);
    if (!home || !away) continue;
    const { lambdaHome, lambdaAway } = expectedGoals(
      home.attack, home.defense, away.attack, away.defense, lr.leagueAvgAttack,
    );
    sumLambda += lambdaHome + lambdaAway;
    countLambda++;
  }

  console.log(`\n[3] Model-predicted avg total goals (Serie A): ${countLambda > 0 ? (sumLambda / countLambda).toFixed(3) : 'n/a'}`);
  console.log(`    League avg attack (Serie A): ${lr.leagueAvgAttack.toFixed(3)}`);
  console.log(`    League avg attack (EPL):     ${lrEpl.leagueAvgAttack.toFixed(3)}`);

  // 4. Score distribution check — are draws counted correctly?
  const draws = matches.filter((m) => m.homeGoals === m.awayGoals).length;
  const homeWins = matches.filter((m) => m.homeGoals! > m.awayGoals!).length;
  const awayWins = matches.filter((m) => m.homeGoals! < m.awayGoals!).length;
  console.log(`\n[4] Score distribution check:`);
  console.log(`    Home wins: ${(homeWins/matches.length*100).toFixed(1)}%  Draws: ${(draws/matches.length*100).toFixed(1)}%  Away wins: ${(awayWins/matches.length*100).toFixed(1)}%`);

  // Compare 0-0 rate
  const nullNull = matches.filter((m) => m.homeGoals === 0 && m.awayGoals === 0).length;
  const oneOne = matches.filter((m) => m.homeGoals === 1 && m.awayGoals === 1).length;
  console.log(`    P(0-0): ${(nullNull/matches.length*100).toFixed(1)}%  P(1-1): ${(oneOne/matches.length*100).toFixed(1)}%`);

  // EPL for comparison
  const eplDraws = eplMatches.filter((m) => m.homeGoals === m.awayGoals).length;
  const eplNullNull = eplMatches.filter((m) => m.homeGoals === 0 && m.awayGoals === 0).length;
  console.log(`    EPL draws: ${(eplDraws/eplMatches.length*100).toFixed(1)}%  EPL P(0-0): ${(eplNullNull/eplMatches.length*100).toFixed(1)}%`);

  // 5. What λ would you need to match empirical over-2.5 rate?
  // P(over 2.5 | Poisson λ) ≈ 1 - e^-λ(1 + λ + λ²/2) roughly
  // Empirically derive what λ fits
  const empiricalOver25Rate = over25 / matches.length;
  console.log(`\n[5] Empirical over 2.5: ${(empiricalOver25Rate*100).toFixed(1)}%`);
  console.log(`    If model predicts 52-58% but actual is 40%, model λ is too high by ~0.3-0.5 goals/game`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
