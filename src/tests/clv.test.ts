import { describe, it, expect } from 'vitest';
import { computeClv, buildClvResult } from '../math/clv.js';
import { odds } from '../types/branded.js';

describe('computeClv', () => {
  it('positive CLV when closing odds > selection odds', () => {
    // Took 2.10, closed at 2.20 → got better than close
    const clv = computeClv(odds(2.10), odds(2.20));
    expect(clv).toBeCloseTo(2.20 / 2.10 - 1, 10);
    expect(clv).toBeGreaterThan(0);
  });

  it('negative CLV when closing odds < selection odds', () => {
    // Took 2.10, closed at 1.95 → market moved against
    const clv = computeClv(odds(2.10), odds(1.95));
    expect(clv).toBeLessThan(0);
  });

  it('zero CLV when closing equals selection', () => {
    const clv = computeClv(odds(2.00), odds(2.00));
    expect(clv).toBeCloseTo(0, 10);
  });
});

describe('CLV / P&L decoupling — structural tests', () => {
  it('losing bet with positive CLV (good process, bad luck)', () => {
    // Took draw at 3.50, closed at 3.80 → positive CLV (+8.6%)
    // But the match result was a home win → lost
    const result = buildClvResult(odds(3.50), odds(3.80), false, 10);

    expect(result.clv).toBeGreaterThan(0);   // good process
    expect(result.pnl).toBe(-10);             // lost the stake
    expect(result.won).toBe(false);

    // CLV and P&L have opposite signs — exactly the decoupled case
    expect(Math.sign(result.clv)).toBe(1);
    expect(Math.sign(result.pnl!)).toBe(-1);
  });

  it('winning bet with negative CLV (bad process, lucky)', () => {
    // Took 1.50, closed at 1.35 → negative CLV (-10%)
    // But it won anyway
    const result = buildClvResult(odds(1.50), odds(1.35), true, 20);

    expect(result.clv).toBeLessThan(0);      // bad process
    expect(result.pnl).toBeCloseTo(10, 5);   // 20 * (1.50 - 1)
    expect(result.won).toBe(true);

    expect(Math.sign(result.clv)).toBe(-1);
    expect(Math.sign(result.pnl!)).toBe(1);
  });

  it('CLV does not change when outcome flips', () => {
    // CLV is computed from odds alone — outcome must not affect it
    const clvWon = buildClvResult(odds(2.10), odds(2.30), true, 10).clv;
    const clvLost = buildClvResult(odds(2.10), odds(2.30), false, 10).clv;
    expect(clvWon).toBe(clvLost);
  });

  it('P&L is null when settlement info is absent', () => {
    const result = buildClvResult(odds(2.00), odds(2.10), null, null);
    expect(result.pnl).toBeNull();
    expect(result.clv).toBeGreaterThan(0); // CLV still computable
  });

  it('pnl formula: win returns stake × (odds - 1)', () => {
    const stake = 50;
    const o = 2.40;
    const result = buildClvResult(odds(o), odds(o), true, stake);
    expect(result.pnl).toBeCloseTo(stake * (o - 1), 8);
  });

  it('pnl formula: loss returns -stake', () => {
    const result = buildClvResult(odds(2.00), odds(1.90), false, 25);
    expect(result.pnl).toBe(-25);
  });
});

describe('CLV magnitude', () => {
  it('~4.8% for Pinnacle closing movement', () => {
    // Common sharp-market scenario: took 2.10, Pinnacle closes 2.20
    const clv = computeClv(odds(2.10), odds(2.20));
    expect(clv).toBeCloseTo(0.04762, 4);
  });

  it('large negative CLV on steamed line', () => {
    // Line moved hard against: took 3.00, closed at 2.20
    const clv = computeClv(odds(3.00), odds(2.20));
    expect(clv).toBeCloseTo(2.20 / 3.00 - 1, 10);
    expect(clv).toBeLessThan(-0.2);
  });
});
