import { buildScoreMatrix, matchProbsFromMatrix } from './poisson.js';
import { applyDixonColes } from './dixonColes.js';

export interface LiveMatchState {
  elapsedMinutes: number;   // 0-90+
  homeGoals: number;
  awayGoals: number;
}

export interface LiveProbs {
  pHome: number;
  pDraw: number;
  pAway: number;
  pOver25: number;
  pBtts: boolean | null;   // null when already determined
  remainingFraction: number;
  // Current score context for display
  homeGoals: number;
  awayGoals: number;
  elapsedMinutes: number;
}

const FULL_MATCH_MINUTES = 90;
// v1: proportional time decay — assumes scoring rate constant after a goal.
// Not true in practice (teams change shape after scoring/conceding).
// Flag for v2: use Bayesian game-state model with separate λ per score state.
function remainingFraction(elapsed: number): number {
  return Math.max(0, 1 - elapsed / FULL_MATCH_MINUTES);
}

/**
 * Recompute match probabilities given current live state.
 *
 * Approach:
 *   1. Scale full-match λ by remaining time fraction
 *   2. Build score matrix for remaining goals only
 *   3. Apply Dixon-Coles τ correction on the *remaining* matrix
 *   4. Convolve: P(final score = h,a) = Σ P(remaining = r_h, r_a) where
 *      final_h = currentHome + r_h, final_a = currentAway + r_a
 *   5. Derive 1X2, O/U 2.5, BTTS from final score distribution
 *
 * Known limitation (v1): ESPN scores cached 60s → live state up to 60s stale.
 */
export function computeLiveProbs(
  lambdaHome: number,
  lambdaAway: number,
  state: LiveMatchState,
  rho: number,
): LiveProbs {
  const rf = remainingFraction(state.elapsedMinutes);

  // Scale λ for remaining time
  const lhRem = lambdaHome * rf;
  const laRem = lambdaAway * rf;

  // If match essentially over (injury time, rf < 0.02), just return current state probs
  if (rf < 0.02) {
    const gh = state.homeGoals;
    const ga = state.awayGoals;
    return {
      pHome: gh > ga ? 1 : 0,
      pDraw: gh === ga ? 1 : 0,
      pAway: ga > gh ? 1 : 0,
      pOver25: (gh + ga) > 2.5 ? 1 : 0,
      pBtts: null,
      remainingFraction: 0,
      homeGoals: gh,
      awayGoals: ga,
      elapsedMinutes: state.elapsedMinutes,
    };
  }

  // Score matrix for remaining goals
  const smRem = buildScoreMatrix(lhRem, laRem);
  const smCorr = applyDixonColes(smRem, rho * rf); // scale ρ by remaining time
  const mat = smCorr.matrix;
  const MAX = mat.length;

  // Convolve with current score to get final score distribution
  let pHome = 0, pDraw = 0, pAway = 0, pOver25 = 0, pBtts = 0;
  let total = 0;

  for (let rh = 0; rh < MAX; rh++) {
    for (let ra = 0; ra < MAX; ra++) {
      const p = mat[rh]?.[ra] ?? 0;
      if (p === 0) continue;
      const fh = state.homeGoals + rh;
      const fa = state.awayGoals + ra;
      total += p;
      if (fh > fa) pHome += p;
      else if (fh === fa) pDraw += p;
      else pAway += p;
      if (fh + fa > 2.5) pOver25 += p;
      if (fh > 0 && fa > 0) pBtts += p;
    }
  }

  // BTTS: if current score already has both teams scoring, it's already true
  // If one team has 0 goals and rf is very low, it may already be determined
  let bttsResult: boolean | null;
  if (state.homeGoals > 0 && state.awayGoals > 0) {
    bttsResult = null; // already true, determined
  } else if (rf < 0.1 && (state.homeGoals === 0 || state.awayGoals === 0)) {
    // very little time left, effectively determined
    bttsResult = null;
  } else {
    bttsResult = null; // return as probability below
  }

  if (total === 0) total = 1;

  return {
    pHome: pHome / total,
    pDraw: pDraw / total,
    pAway: pAway / total,
    pOver25: pOver25 / total,
    pBtts: bttsResult ?? (state.homeGoals > 0 && state.awayGoals > 0 ? null : null),
    remainingFraction: rf,
    homeGoals: state.homeGoals,
    awayGoals: state.awayGoals,
    elapsedMinutes: state.elapsedMinutes,
  };
}

// pBtts as a number (probability) for UI display
export function pBttsLive(
  lambdaHome: number,
  lambdaAway: number,
  state: LiveMatchState,
  rho: number,
): number {
  if (state.homeGoals > 0 && state.awayGoals > 0) return 1;

  const rf = remainingFraction(state.elapsedMinutes);
  const lhRem = lambdaHome * rf;
  const laRem = lambdaAway * rf;
  const smRem = buildScoreMatrix(lhRem, laRem);
  const smCorr = applyDixonColes(smRem, rho * rf);
  const mat2 = smCorr.matrix;
  const MAX = mat2.length;

  let pBtts = 0, total = 0;
  for (let rh = 0; rh < MAX; rh++) {
    for (let ra = 0; ra < MAX; ra++) {
      const p = mat2[rh]?.[ra] ?? 0;
      if (p === 0) continue;
      total += p;
      const fh = state.homeGoals + rh;
      const fa = state.awayGoals + ra;
      if (fh > 0 && fa > 0) pBtts += p;
    }
  }
  return total > 0 ? pBtts / total : 0;
}
