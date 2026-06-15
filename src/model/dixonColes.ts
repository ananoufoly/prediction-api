import {
  buildScoreMatrix,
  matchProbsFromMatrix,
  expectedGoals,
  type MatchProbabilities,
} from './poisson.js';

/**
 * Dixon-Coles correction for low-score bias.
 *
 * The correction factor τ adjusts P(0-0), P(1-0), P(0-1), P(1-1):
 *   τ(0,0) = 1 - λ_home * λ_away * ρ
 *   τ(1,0) = 1 + λ_away * ρ
 *   τ(0,1) = 1 + λ_home * ρ
 *   τ(1,1) = 1 - ρ
 *   τ(h,a) = 1  otherwise
 *
 * ρ < 0 → increases P(0-0) and P(1-1) relative to pure Poisson.
 * Typical fitted ρ for football: [-0.2, 0.0].
 */
function tau(h: number, a: number, lh: number, la: number, rho: number): number {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

export type ScoreMatrixResult = ReturnType<typeof buildScoreMatrix>;

export function applyDixonColes(sm: ScoreMatrixResult, rho: number): ScoreMatrixResult {
  if (rho === 0) return sm;
  const { matrix, lambdaHome: lh, lambdaAway: la } = sm;
  const corrected = matrix.map((row, h) =>
    row.map((p, a) => p * tau(h, a, lh, la, rho)),
  );

  // Re-normalise (correction shifts total probability slightly)
  const total = corrected.reduce((s, row) => s + row.reduce((rs, p) => rs + p, 0), 0);
  const normalised = corrected.map((row) => row.map((p) => p / total));

  return { matrix: normalised, lambdaHome: lh, lambdaAway: la };
}

export function computeMatchProbsDC(
  homeAttack: number,
  homeDefense: number,
  awayAttack: number,
  awayDefense: number,
  leagueAvg: number,
  rho: number,
  homeAdvantage?: number,
  goalConversionFactor = 1.0,
): MatchProbabilities {
  const { lambdaHome, lambdaAway } = expectedGoals(
    homeAttack, homeDefense, awayAttack, awayDefense, leagueAvg, homeAdvantage, goalConversionFactor,
  );
  const sm = buildScoreMatrix(lambdaHome, lambdaAway);
  const corrected = applyDixonColes(sm, rho);
  return matchProbsFromMatrix(corrected);
}

/**
 * Fit ρ for a league via MLE on historical matches.
 * Uses golden-section search over ρ ∈ [-0.3, 0.1].
 */
export interface FitRhoResult {
  rho: number;
  logLik: number;
  logLikNull: number;
  improvement: number;
  nMatches: number;
}

export interface TrainingMatch {
  lambdaHome: number;
  lambdaAway: number;
  homeGoals: number;
  awayGoals: number;
}

function logLikelihood(matches: TrainingMatch[], rho: number): number {
  let ll = 0;
  for (const m of matches) {
    const sm = buildScoreMatrix(m.lambdaHome, m.lambdaAway);
    const corrected = applyDixonColes(sm, rho);
    const p = corrected.matrix[m.homeGoals]?.[m.awayGoals] ?? 1e-10;
    ll += Math.log(Math.max(p, 1e-10));
  }
  return ll;
}

export function fitRho(matches: TrainingMatch[]): FitRhoResult {
  const RHO_MIN = -0.3;
  const RHO_MAX = 0.1;
  const TOL = 1e-6;

  // Golden-section search for maximum
  const phi = (1 + Math.sqrt(5)) / 2;
  let a = RHO_MIN, b = RHO_MAX;
  let c = b - (b - a) / phi;
  let d = a + (b - a) / phi;

  const f = (x: number) => -logLikelihood(matches, x); // negate → minimise

  let fc = f(c), fd = f(d);

  for (let i = 0; i < 200 && Math.abs(b - a) > TOL; i++) {
    if (fc < fd) {
      b = d; d = c; fd = fc;
      c = b - (b - a) / phi; fc = f(c);
    } else {
      a = c; c = d; fc = fd;
      d = a + (b - a) / phi; fd = f(d);
    }
  }

  const rho = (a + b) / 2;
  const logLik = logLikelihood(matches, rho);
  const logLikNull = logLikelihood(matches, 0);

  if (Math.abs(rho - RHO_MIN) < 0.01 || Math.abs(rho - RHO_MAX) < 0.01) {
    console.warn(`[dc] ρ converged near boundary: ${rho.toFixed(4)} — check data quality`);
  }

  return { rho, logLik, logLikNull, improvement: logLik - logLikNull, nMatches: matches.length };
}
