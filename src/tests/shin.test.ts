import { describe, it, expect } from 'vitest';
import { shinDevig, proportionalDevig } from '../math/shin.js';

const SUM_TOL = 1e-9;
const PROB_TOL = 1e-6;

function expectSumsToOne(probs: number[]): void {
  const sum = probs.reduce((a, b) => a + b, 0);
  expect(Math.abs(sum - 1)).toBeLessThan(SUM_TOL);
}

describe('shinDevig — 2-outcome market (over/under)', () => {
  // Pinnacle-style ~2.5% margin: 1.93 / 1.93
  const result = shinDevig([1.93, 1.93]);

  it('converges via Shin method', () => {
    expect(result.method).toBe('shin');
  });

  it('probabilities sum to 1', () => {
    expectSumsToOne(result.probabilities);
  });

  it('balanced book → equal probs ~0.5', () => {
    expect(Math.abs((result.probabilities[0] ?? 0) - 0.5)).toBeLessThan(PROB_TOL);
    expect(Math.abs((result.probabilities[1] ?? 0) - 0.5)).toBeLessThan(PROB_TOL);
  });

  it('z is positive (some insider proportion)', () => {
    expect(result.z).toBeGreaterThan(0);
  });
});

describe('shinDevig — 3-outcome market (1X2)', () => {
  // Typical 1X2: home 1.80, draw 3.50, away 4.50 (~6% margin)
  const odds = [1.80, 3.50, 4.50];
  const result = shinDevig(odds);

  it('converges via Shin method', () => {
    expect(result.method).toBe('shin');
  });

  it('probabilities sum to 1', () => {
    expectSumsToOne(result.probabilities);
  });

  it('home prob is highest', () => {
    const [h, d, a] = result.probabilities;
    expect(h).toBeGreaterThan(d!);
    expect(h).toBeGreaterThan(a!);
  });

  it('all probs are strictly positive', () => {
    for (const p of result.probabilities) {
      expect(p).toBeGreaterThan(0);
    }
  });
});

describe('shinDevig — Pinnacle-style balanced book (~2.5% margin)', () => {
  // h2h: 2.05 / 1.80 (slight favourite)
  const pinnacleOdds = [2.05, 1.80];
  const shinResult = shinDevig(pinnacleOdds);
  const propResult = proportionalDevig(pinnacleOdds);

  it('sums to 1', () => {
    expectSumsToOne(shinResult.probabilities);
  });

  it('low z for tight book', () => {
    // ~2.5% margin → z should be small
    expect(shinResult.z).toBeLessThan(0.05);
  });

  it('Shin and proportional are close for tight books', () => {
    // Small margin → both methods should agree within 0.5pp
    for (let i = 0; i < 2; i++) {
      expect(Math.abs((shinResult.probabilities[i] ?? 0) - (propResult[i] ?? 0))).toBeLessThan(0.005);
    }
  });
});

describe('shinDevig — heavily-shaded book (~12% margin)', () => {
  // 1/1.50 + 1/2.20 = 0.667 + 0.455 = 1.122 → ~12% overround (retail-grade book)
  const heavyOdds = [1.50, 2.20];
  const shinResult = shinDevig(heavyOdds);
  const propResult = proportionalDevig(heavyOdds);

  it('sums to 1', () => {
    expectSumsToOne(shinResult.probabilities);
  });

  it('higher z for heavier book', () => {
    // More margin → more insider proportion estimated
    const lightZ = shinDevig([1.93, 1.93]).z;
    expect(shinResult.z).toBeGreaterThan(lightZ);
  });

  it('Shin and proportional diverge meaningfully (>0.5pp on at least one outcome)', () => {
    // Shin and proportional must not be identical for a heavily-margined book.
    // Direction: Shin accounts for insider trading → concentrates probability
    // on the favourite more than proportional does for a large overround.
    const maxDiff = Math.max(
      ...shinResult.probabilities.map((p, i) => Math.abs(p - (propResult[i] ?? 0))),
    );
    expect(maxDiff).toBeGreaterThan(0.005);
  });

  it('Shin probabilities differ from proportional in a consistent direction', () => {
    // For a 2-outcome book with overround, Shin and proportional must disagree
    // (one goes up, one goes down — they cannot both be the same)
    const diff0 = (shinResult.probabilities[0] ?? 0) - (propResult[0] ?? 0);
    const diff1 = (shinResult.probabilities[1] ?? 0) - (propResult[1] ?? 0);
    // One positive, one negative (probability is conserved, sums to 1)
    expect(diff0 * diff1).toBeLessThan(0);
  });
});

describe('shinDevig — edge cases', () => {
  it('throws for single outcome', () => {
    expect(() => shinDevig([2.0])).toThrow('at least 2');
  });

  it('throws for odds <= 1', () => {
    expect(() => shinDevig([0.9, 2.0])).toThrow('Invalid decimal odds');
  });

  it('handles 4-outcome market', () => {
    const result = shinDevig([3.0, 3.0, 3.0, 3.0]);
    expectSumsToOne(result.probabilities);
    for (const p of result.probabilities) {
      expect(Math.abs(p - 0.25)).toBeLessThan(PROB_TOL);
    }
  });
});
