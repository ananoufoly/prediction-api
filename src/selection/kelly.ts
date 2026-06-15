/**
 * Quarter-Kelly stake sizing, capped at 2% of bankroll.
 *
 * Full Kelly: f = (p * b - q) / b  where b = decimal_odds - 1, q = 1 - p
 * Quarter Kelly: f* = f / 4
 * Cap: min(f*, 0.02)
 *
 * Kelly with edge < 0 → f < 0 → stake 0 (never bet negative edge).
 */

const KELLY_FRACTION = 0.25;
const MAX_STAKE_PCT = 0.02;

export interface KellyResult {
  fullKelly: number;
  quarterKelly: number;
  recommendedStakePct: number;
  recommendedStake: number;
}

export function computeKelly(
  modelProb: number,
  decimalOdds: number,
  bankroll: number,
): KellyResult {
  const b = decimalOdds - 1;
  const q = 1 - modelProb;
  const fullKelly = (modelProb * b - q) / b;

  if (fullKelly <= 0) {
    return { fullKelly, quarterKelly: 0, recommendedStakePct: 0, recommendedStake: 0 };
  }

  const quarterKelly = fullKelly * KELLY_FRACTION;
  const recommendedStakePct = Math.min(quarterKelly, MAX_STAKE_PCT);
  const recommendedStake = recommendedStakePct * bankroll;

  return { fullKelly, quarterKelly, recommendedStakePct, recommendedStake };
}
