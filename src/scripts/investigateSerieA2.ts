import { prisma } from '../db.js';
import { computeXgRatings } from '../model/xgRatings.js';
import { expectedGoals, buildScoreMatrix, matchProbsFromMatrix } from '../model/poisson.js';

async function main() {
  const league = 'Serie A';
  const lr = await computeXgRatings(league);

  const matches = await prisma.match.findMany({
    where: { league, status: 'FINAL', homeGoals: { not: null } },
    orderBy: { kickoffUtc: 'asc' },
  });

  let sumLambdaAll = 0, countAll = 0;
  let sumPredOver25 = 0, countOver25 = 0;
  let actualOver25 = 0;

  for (const m of matches) {
    const home = lr.teams.get(m.homeTeam);
    const away = lr.teams.get(m.awayTeam);
    if (!home || !away) continue;

    const { lambdaHome, lambdaAway } = expectedGoals(
      home.attack, home.defense, away.attack, away.defense, lr.leagueAvgAttack,
    );
    const sm = buildScoreMatrix(lambdaHome, lambdaAway);
    const probs = matchProbsFromMatrix(sm);

    sumLambdaAll += lambdaHome + lambdaAway;
    sumPredOver25 += probs.pOver25;
    countAll++;
    countOver25++;
    if (m.homeGoals! + m.awayGoals! > 2) actualOver25++;
  }

  console.log(`\nFull dataset (n=${countAll}):`);
  console.log(`  Avg model λ_total: ${(sumLambdaAll / countAll).toFixed(3)}`);
  console.log(`  Avg predicted P(over 2.5): ${(sumPredOver25 / countOver25 * 100).toFixed(1)}%`);
  console.log(`  Actual over 2.5 rate: ${(actualOver25 / countAll * 100).toFixed(1)}%`);
  console.log(`  Gap: ${((sumPredOver25 / countOver25 - actualOver25 / countAll) * 100).toFixed(1)}pp`);

  // Check: are leagueAvgAttack ratings inflated vs actual goals?
  const avgActualGoals = matches.reduce((s, m) => s + m.homeGoals! + m.awayGoals!, 0) / matches.length;
  console.log(`\n  Actual avg goals/match: ${avgActualGoals.toFixed(3)}`);
  console.log(`  leagueAvgAttack (raw): ${lr.leagueAvgAttack.toFixed(3)} goals/team/game`);
  console.log(`  Expected λ_total for avg match: ${(lr.leagueAvgAttack * 1.25 + lr.leagueAvgAttack).toFixed(3)}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
