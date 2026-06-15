import { computeXgRatings } from '../model/xgRatings.js';
import { computeMatchProbs, expectedGoals, buildScoreMatrix } from '../model/poisson.js';
import { applyDixonColes, fitRho, type TrainingMatch } from '../model/dixonColes.js';
import { prisma } from '../db.js';

async function main() {
  const leagues = ['EPL', 'La Liga', 'Bundesliga', 'Serie A'];

  for (const league of leagues) {
    const lr = await computeXgRatings(league);
    if (lr.teams.size === 0) { console.log(`${league}: no data`); continue; }

    // Build training matches: matches where we have ratings for both teams
    const matches = await prisma.match.findMany({
      where: { league, status: 'FINAL', homeGoals: { not: null } },
      orderBy: { kickoffUtc: 'asc' },
    });

    const training: TrainingMatch[] = [];
    for (const m of matches) {
      const home = lr.teams.get(m.homeTeam);
      const away = lr.teams.get(m.awayTeam);
      if (!home || !away) continue;
      const { lambdaHome, lambdaAway } = expectedGoals(
        home.attack, home.defense, away.attack, away.defense, lr.leagueAvgAttack,
      );
      training.push({ lambdaHome, lambdaAway, homeGoals: m.homeGoals!, awayGoals: m.awayGoals! });
    }

    const fit = fitRho(training);
    console.log(`\n${league}: ρ=${fit.rho.toFixed(4)}  LL improvement=${fit.improvement.toFixed(2)}  n=${fit.nMatches}`);

    // Verify DC increases P(0-0) and P(1-1) vs pure Poisson
    const avgHome = lr.leagueAvgAttack;
    const avgAway = lr.leagueAvgAttack / 1.25; // roughly neutral
    const smPure = buildScoreMatrix(avgHome, avgAway);
    const smDC = applyDixonColes(smPure, fit.rho);

    const p00Pure = smPure.matrix[0]?.[0] ?? 0;
    const p11Pure = smPure.matrix[1]?.[1] ?? 0;
    const p00DC = smDC.matrix[0]?.[0] ?? 0;
    const p11DC = smDC.matrix[1]?.[1] ?? 0;

    console.log(`  P(0-0): Poisson=${(p00Pure * 100).toFixed(2)}%  DC=${(p00DC * 100).toFixed(2)}%  Δ=${((p00DC - p00Pure) * 100).toFixed(3)}pp`);
    console.log(`  P(1-1): Poisson=${(p11Pure * 100).toFixed(2)}%  DC=${(p11DC * 100).toFixed(2)}%  Δ=${((p11DC - p11Pure) * 100).toFixed(3)}pp`);

    if (fit.rho < -0.2 || fit.rho > 0.05) {
      console.warn(`  ⚠️  ρ outside expected [-0.2, 0.05] range`);
    } else {
      console.log(`  ✓ ρ in expected range`);
    }
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
