/**
 * Bivariate Poisson match outcome probabilities.
 *
 * Expected goals:
 *   λ_home = leagueAvgAttack * homeAttack * awayDefense * homeAdvantage
 *   λ_away = leagueAvgAttack * awayAttack * homeDefense
 *
 * homeAdvantage is a multiplicative factor fitted per league (default 1.25).
 */

export const HOME_ADVANTAGE = 1.25;
const MAX_GOALS = 10; // truncate score matrix at 10

/** Poisson PMF */
function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

export interface ScoreMatrix {
  /** matrix[home][away] = P(home goals = h, away goals = a) */
  matrix: number[][];
  lambdaHome: number;
  lambdaAway: number;
}

export interface MatchProbabilities {
  pHome: number;
  pDraw: number;
  pAway: number;
  pOver25: number;
  pBtts: number;
  scoreMatrix: ScoreMatrix;
}

export function expectedGoals(
  homeAttack: number,
  homeDefense: number,
  awayAttack: number,
  awayDefense: number,
  leagueAvg: number,
  homeAdvantage = HOME_ADVANTAGE,
  goalConversionFactor = 1.0,
): { lambdaHome: number; lambdaAway: number } {
  const lambdaHome = leagueAvg * homeAttack * awayDefense * homeAdvantage * goalConversionFactor;
  const lambdaAway = leagueAvg * awayAttack * homeDefense * goalConversionFactor;
  return { lambdaHome, lambdaAway };
}

export function buildScoreMatrix(lambdaHome: number, lambdaAway: number): ScoreMatrix {
  const matrix: number[][] = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    matrix[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) {
      matrix[h]![a] = poissonPmf(lambdaHome, h) * poissonPmf(lambdaAway, a);
    }
  }
  return { matrix, lambdaHome, lambdaAway };
}

export function matchProbsFromMatrix(sm: ScoreMatrix): MatchProbabilities {
  let pHome = 0, pDraw = 0, pAway = 0, pOver25 = 0, pBtts = 0;

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = sm.matrix[h]![a]!;
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h + a > 2.5) pOver25 += p;
      if (h > 0 && a > 0) pBtts += p;
    }
  }

  return { pHome, pDraw, pAway, pOver25, pBtts, scoreMatrix: sm };
}

export function computeMatchProbs(
  homeAttack: number,
  homeDefense: number,
  awayAttack: number,
  awayDefense: number,
  leagueAvg: number,
  homeAdvantage = HOME_ADVANTAGE,
  goalConversionFactor = 1.0,
): MatchProbabilities {
  const { lambdaHome, lambdaAway } = expectedGoals(
    homeAttack, homeDefense, awayAttack, awayDefense, leagueAvg, homeAdvantage, goalConversionFactor,
  );
  const sm = buildScoreMatrix(lambdaHome, lambdaAway);
  return matchProbsFromMatrix(sm);
}
