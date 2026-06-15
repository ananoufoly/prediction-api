import { prisma } from '../db.js';
import { computeXgRatings } from './xgRatings.js';
import { applyEloPriors } from './elo.js';
import { computeMatchProbsDC, fitRho, type TrainingMatch } from './dixonColes.js';
import { expectedGoals } from './poisson.js';

export interface BacktestPrediction {
  matchId: string;
  kickoffUtc: Date;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  pHome: number;
  pDraw: number;
  pAway: number;
  pOver25: number;
  pBtts: number;
  actualHome: boolean;
  actualDraw: boolean;
  actualAway: boolean;
  actualOver25: boolean;
  actualBtts: boolean;
}

/**
 * Walk-forward backtest: for each match in the test set,
 * use only matches before its date to fit ratings + ρ, then predict.
 *
 * trainWindowDays: how many days of history to use for ratings.
 * stepDays: re-fit ratings every N days (for efficiency; full re-fit is too slow).
 */
export async function runBacktest(
  league: string,
  trainWindowDays = 365,
  stepDays = 30,
): Promise<BacktestPrediction[]> {
  const allMatches = await prisma.match.findMany({
    where: { league, status: 'FINAL', homeGoals: { not: null } },
    orderBy: { kickoffUtc: 'asc' },
  });

  if (allMatches.length < 100) {
    console.warn(`[backtest] ${league}: only ${allMatches.length} matches — insufficient for backtest`);
    return [];
  }

  // Hold out last 20% for test, use prior 80% to establish initial ratings
  const splitIdx = Math.floor(allMatches.length * 0.8);
  const testMatches = allMatches.slice(splitIdx);

  console.log(`[backtest] ${league}: ${allMatches.length} total, ${testMatches.length} test matches`);

  const predictions: BacktestPrediction[] = [];
  let lastFitDate = new Date(0);
  let cachedRho = -0.1;
  let cachedRatings: Awaited<ReturnType<typeof computeXgRatings>> | null = null;

  for (const m of testMatches) {
    const daysSinceLastFit =
      (m.kickoffUtc.getTime() - lastFitDate.getTime()) / 86_400_000;

    if (daysSinceLastFit >= stepDays || cachedRatings === null) {
      // Re-fit using matches before this one
      const trainMatches = allMatches.filter((x) => x.kickoffUtc < m.kickoffUtc);
      const refDate = m.kickoffUtc;

      // Compute ratings up to this date
      cachedRatings = await computeXgRatings(league, refDate);
      await applyEloPriors(league, cachedRatings.teams);

      // Fit ρ on training matches where we have ratings
      const training: TrainingMatch[] = [];
      for (const tm of trainMatches.slice(-Math.min(trainMatches.length, 500))) {
        const home = cachedRatings.teams.get(tm.homeTeam);
        const away = cachedRatings.teams.get(tm.awayTeam);
        if (!home || !away) continue;
        const { lambdaHome, lambdaAway } = expectedGoals(
          home.attack, home.defense, away.attack, away.defense,
          cachedRatings.leagueAvgAttack, undefined, cachedRatings.goalConversionFactor,
        );
        training.push({ lambdaHome, lambdaAway, homeGoals: tm.homeGoals!, awayGoals: tm.awayGoals! });
      }

      if (training.length >= 50) {
        const fit = fitRho(training);
        cachedRho = fit.rho;
      }

      lastFitDate = m.kickoffUtc;
    }

    const home = cachedRatings!.teams.get(m.homeTeam);
    const away = cachedRatings!.teams.get(m.awayTeam);

    if (!home || !away) continue;

    const probs = computeMatchProbsDC(
      home.attack, home.defense,
      away.attack, away.defense,
      cachedRatings!.leagueAvgAttack,
      cachedRho,
      undefined,
      cachedRatings!.goalConversionFactor,
    );

    const hg = m.homeGoals!;
    const ag = m.awayGoals!;

    predictions.push({
      matchId: m.id,
      kickoffUtc: m.kickoffUtc,
      league,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      homeGoals: hg,
      awayGoals: ag,
      pHome: probs.pHome,
      pDraw: probs.pDraw,
      pAway: probs.pAway,
      pOver25: probs.pOver25,
      pBtts: probs.pBtts,
      actualHome: hg > ag,
      actualDraw: hg === ag,
      actualAway: hg < ag,
      actualOver25: hg + ag > 2,
      actualBtts: hg > 0 && ag > 0,
    });
  }

  return predictions;
}

export async function runAllLeagueBacktests(): Promise<Map<string, BacktestPrediction[]>> {
  const leagues = ['EPL', 'La Liga', 'Bundesliga', 'Serie A'];
  const results = new Map<string, BacktestPrediction[]>();
  for (const league of leagues) {
    results.set(league, await runBacktest(league));
  }
  return results;
}
