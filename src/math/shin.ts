import { type Probability, prob } from '../types/branded.js';

export interface ShinResult {
  probabilities: Probability[];
  z: number;
  method: 'shin' | 'proportional';
}

/**
 * Shin's method de-vigging.
 *
 * Given implied probs q_i = 1/o_i (sum to S > 1), find fair probs p_i.
 *
 * Shin (1993) formula:
 *   p_i = [ sqrt(z^2 + 4(1-z) * q_i^2 / S) - z ] / [ 2(1-z) ]
 *
 * We find z in (0,1) such that sum(p_i) = 1.
 *
 * Key insight: for S > 1 (overround > 1), z > 0 exists uniquely.
 * Uses bisection — unconditionally robust, fast enough for n≤10.
 */
export function shinDevig(decimalOdds: number[]): ShinResult {
  if (decimalOdds.length < 2) {
    throw new Error('shinDevig requires at least 2 outcomes');
  }
  for (const o of decimalOdds) {
    if (o <= 1) throw new Error(`Invalid decimal odds: ${o} — must be > 1`);
  }

  const q = decimalOdds.map((o) => 1 / o);
  const S = q.reduce((a, b) => a + b, 0);

  // At z=0: sum(p_i) = sum(q_i/sqrt(S)) = sqrt(S) > 1 for S>1
  // As z→1: each p_i → q_i/S (proportional), sum → 1 from above? No.
  // Actually at z=1 formula degenerates. We need to find the root of f(z)=sum(p_i)-1.
  //
  // f(0) = sum( sqrt(q_i^2/S) ) = sum(q_i)/sqrt(S) = sqrt(S) > 1
  // f(z*) = 1 for some z* in (0, 1)
  // f is monotonically decreasing in z (more insiders → more compression → lower sum)
  // So root exists and is unique in (0, 1).

  const shinProb = (z: number, qi: number): number => {
    const disc = z * z + 4 * (1 - z) * qi * qi / S;
    return (Math.sqrt(disc) - z) / (2 * (1 - z));
  };

  const sumProbs = (z: number): number =>
    q.reduce((acc, qi) => acc + shinProb(z, qi), 0);

  const TOL = 1e-9;
  const MAX_ITER = 200;

  // Bisection over (0, 1-ε)
  // Verify bracket
  const f0 = sumProbs(1e-12) - 1;  // should be > 0
  const f1 = sumProbs(1 - 1e-12) - 1;  // should be < 0 (at z→1 probs → q_i/S, sum→1 from... need to check sign)

  if (f0 < 0 || f1 > 0) {
    // Bracket failed — fall back
    console.warn(`[shin] Bracket failed (f0=${f0.toFixed(6)}, f1=${f1.toFixed(6)}, S=${S.toFixed(4)}) — falling back to proportional`);
    return {
      probabilities: q.map((qi) => prob(qi / S)),
      z: 0,
      method: 'proportional',
    };
  }

  let lo = 1e-12, hi = 1 - 1e-12;
  let z = 0;
  let converged = false;

  for (let i = 0; i < MAX_ITER; i++) {
    z = (lo + hi) / 2;
    const f = sumProbs(z) - 1;
    if (Math.abs(f) < TOL || (hi - lo) / 2 < TOL) {
      converged = true;
      break;
    }
    if (f > 0) lo = z; else hi = z;
  }

  if (!converged) {
    // Try Newton refinement from current z
    for (let i = 0; i < 100; i++) {
      const f = sumProbs(z) - 1;
      if (Math.abs(f) < TOL) { converged = true; break; }
      // Numerical derivative
      const h = 1e-7;
      const df = (sumProbs(z + h) - sumProbs(z - h)) / (2 * h);
      if (df === 0) break;
      const zNext = Math.max(1e-12, Math.min(1 - 1e-12, z - f / df));
      if (Math.abs(zNext - z) < TOL) { z = zNext; converged = true; break; }
      z = zNext;
    }
  }

  if (!converged) {
    console.warn(`[shin] Failed to converge (S=${S.toFixed(4)}, n=${decimalOdds.length}) — falling back to proportional de-vig`);
    return {
      probabilities: q.map((qi) => prob(qi / S)),
      z: 0,
      method: 'proportional',
    };
  }

  const probs = q.map((qi) => shinProb(z, qi));
  return {
    probabilities: probs.map((p) => prob(p)),
    z,
    method: 'shin',
  };
}

/** Proportional de-vig (simple baseline, used as fallback) */
export function proportionalDevig(decimalOdds: number[]): Probability[] {
  const q = decimalOdds.map((o) => 1 / o);
  const S = q.reduce((a, b) => a + b, 0);
  return q.map((qi) => prob(qi / S));
}
