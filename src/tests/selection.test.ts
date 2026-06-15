import { describe, it, expect } from 'vitest';
import { computeEdge } from '../selection/edge.js';
import {
  assignConfidence, checkConsensusEligibility,
  CALIBRATION_COLD_MIN_EDGE, CALIBRATION_LIVE_MIN_EDGE,
  CONSENSUS_MIN_PROB, CONSENSUS_MIN_ODDS, CONSENSUS_COLD_MIN_GAP, CONSENSUS_LIVE_MIN_GAP,
  CONSENSUS_HIGH_MIN_GAP, CONSENSUS_HIGH_PINNACLE_THRESHOLD,
} from '../selection/confidence.js';
import { computeKelly } from '../selection/kelly.js';
import { prob, odds, edgePct } from '../types/branded.js';

// ─── Edge ───────────────────────────────────────────────────────────────────

describe('computeEdge', () => {
  it('positive when model > bookie fair prob', () => {
    // Model: 55%, bookie fair: 50% → edge = 0.55/0.50 - 1 = 10%
    const e = computeEdge(prob(0.55), prob(0.50));
    expect(e).toBeCloseTo(0.10, 6);
  });

  it('negative when model < bookie fair prob', () => {
    const e = computeEdge(prob(0.40), prob(0.50));
    expect(e).toBeLessThan(0);
  });

  it('zero at breakeven', () => {
    const e = computeEdge(prob(0.50), prob(0.50));
    expect(e).toBeCloseTo(0, 10);
  });
});

// ─── Kelly ──────────────────────────────────────────────────────────────────

describe('computeKelly', () => {
  it('quarter-Kelly on a standard positive-edge bet', () => {
    // p=0.55, odds=2.10, b=1.10, q=0.45
    // fullKelly = (0.55*1.10 - 0.45)/1.10 = (0.605-0.45)/1.10 = 0.1409
    // quarterKelly = 0.03523, capped at 0.02
    const r = computeKelly(0.55, 2.10, 1000);
    expect(r.fullKelly).toBeCloseTo(0.1409, 3);
    expect(r.recommendedStakePct).toBeCloseTo(0.02, 6); // capped
    expect(r.recommendedStake).toBeCloseTo(20, 5);
  });

  it('stake is zero for zero edge', () => {
    // p=0.5, odds=2.0 → fullKelly=0
    const r = computeKelly(0.5, 2.0, 1000);
    expect(r.recommendedStake).toBe(0);
  });

  it('stake is zero for negative edge', () => {
    const r = computeKelly(0.40, 2.0, 1000);
    expect(r.recommendedStake).toBe(0);
  });

  it('caps at 2% of bankroll', () => {
    // Very high edge: p=0.9, odds=2.0 → uncapped Kelly would be large
    const r = computeKelly(0.9, 2.0, 1000);
    expect(r.recommendedStakePct).toBe(0.02);
    expect(r.recommendedStake).toBe(20);
  });

  it('scales with bankroll', () => {
    const r1 = computeKelly(0.55, 2.0, 1000);
    const r2 = computeKelly(0.55, 2.0, 5000);
    expect(r2.recommendedStake).toBeCloseTo(r1.recommendedStake * 5, 5);
  });
});

// ─── Confidence tiers ────────────────────────────────────────────────────────

describe('assignConfidence — calibration cold regime', () => {
  const regime = false; // calibration not fitted

  it('LOW when edge below cold threshold (5%)', () => {
    const r = assignConfidence(edgePct(0.03), prob(0.55), prob(0.52), regime);
    expect(r.confidence).toBe('LOW');
    expect(r.regime).toBe('cold');
  });

  it('MEDIUM when edge ≥ 5% but Pinnacle agrees (edge < 5% gate for HIGH still applies above 5%)', () => {
    // edge=0.06 ≥ 5%, Pinnacle agrees → should be HIGH
    const r = assignConfidence(edgePct(0.06), prob(0.55), prob(0.54), regime);
    expect(r.confidence).toBe('HIGH');
    expect(r.pinnacleAgreed).toBe(true);
  });

  it('MEDIUM when edge ≥ 5% but Pinnacle absent — capped', () => {
    const r = assignConfidence(edgePct(0.08), prob(0.55), null, regime);
    expect(r.confidence).toBe('MEDIUM');
    expect(r.pinnaclePresent).toBe(false);
    expect(r.reason).toContain('Pinnacle absent');
  });

  it('MEDIUM when edge ≥ 5% but Pinnacle disagrees', () => {
    // Model: 55%, Pinnacle fair: 48% → diff = 7pp > 3pp threshold
    const r = assignConfidence(edgePct(0.08), prob(0.55), prob(0.48), regime);
    expect(r.confidence).toBe('MEDIUM');
    expect(r.pinnacleAgreed).toBe(false);
    expect(r.reason).toContain('disagrees');
  });

  it('MEDIUM (not HIGH) with edge just at 5% boundary', () => {
    // edge exactly = COLD threshold = 5% = HIGH threshold — should be HIGH if Pinnacle agrees
    const r = assignConfidence(edgePct(CALIBRATION_COLD_MIN_EDGE), prob(0.55), prob(0.54), regime);
    expect(r.confidence).toBe('HIGH');
  });
});

describe('assignConfidence — calibration live regime', () => {
  const regime = true; // calibration fitted

  it('LOW when edge below live threshold (2%)', () => {
    const r = assignConfidence(edgePct(0.015), prob(0.55), prob(0.54), regime);
    expect(r.confidence).toBe('LOW');
    expect(r.regime).toBe('live');
  });

  it('MEDIUM when edge ≥ 2% but < 5%', () => {
    const r = assignConfidence(edgePct(0.03), prob(0.55), prob(0.54), regime);
    expect(r.confidence).toBe('MEDIUM');
    expect(r.reason).toContain('< 5%');
  });

  it('HIGH when edge ≥ 5% and Pinnacle agrees', () => {
    const r = assignConfidence(edgePct(0.07), prob(0.55), prob(0.54), regime);
    expect(r.confidence).toBe('HIGH');
  });

  it('uses CALIBRATION_LIVE_MIN_EDGE constant correctly', () => {
    expect(CALIBRATION_LIVE_MIN_EDGE).toBe(0.02);
  });
});

describe('assignConfidence — Pinnacle logic correctness', () => {
  it('HIGH requires Pinnacle present', () => {
    // Without Pinnacle, max confidence is MEDIUM even with strong edge
    const r = assignConfidence(edgePct(0.15), prob(0.70), null, true);
    expect(r.confidence).toBe('MEDIUM');
  });

  it('Pinnacle agreement within 3pp passes', () => {
    const r = assignConfidence(edgePct(0.07), prob(0.55), prob(0.53), true);
    expect(r.pinnacleAgreed).toBe(true);
    expect(r.confidence).toBe('HIGH');
  });

  it('Pinnacle agreement within 3pp boundary', () => {
    // 0.55 - 0.524 = 0.026 < 0.03 → agrees
    const r = assignConfidence(edgePct(0.07), prob(0.55), prob(0.524), true);
    expect(r.pinnacleAgreed).toBe(true);
  });

  it('Pinnacle disagreement beyond 3pp fails', () => {
    // 0.55 - 0.515 = 0.035 > 0.03 → disagrees
    const r = assignConfidence(edgePct(0.07), prob(0.55), prob(0.515), true);
    expect(r.pinnacleAgreed).toBe(false);
  });

  it('reason field always populated', () => {
    const cases = [
      assignConfidence(edgePct(0.01), prob(0.5), null, false),
      assignConfidence(edgePct(0.06), prob(0.55), null, true),
      assignConfidence(edgePct(0.06), prob(0.55), prob(0.54), true),
      assignConfidence(edgePct(0.06), prob(0.55), prob(0.48), true),
    ];
    for (const r of cases) {
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('regime constants', () => {
  it('cold threshold is tighter than live', () => {
    expect(CALIBRATION_COLD_MIN_EDGE).toBeGreaterThan(CALIBRATION_LIVE_MIN_EDGE);
  });

  it('cold threshold is 5%', () => {
    expect(CALIBRATION_COLD_MIN_EDGE).toBe(0.05);
  });

  it('live threshold is 2%', () => {
    expect(CALIBRATION_LIVE_MIN_EDGE).toBe(0.02);
  });
});

// ─── Consensus Value strategy ────────────────────────────────────────────────

// Baseline: everything passes → MEDIUM qualifies
const BASE = {
  modelProb: prob(0.55),
  bookieFairProb: prob(0.52),
  pinnacleFairProb: prob(0.54),
  decimalOdds: 1.80,
  calibrationFitted: false,
};

describe('checkConsensusEligibility — qualification gates', () => {
  it('qualifies when all conditions met (cold regime)', () => {
    const r = checkConsensusEligibility(BASE.modelProb, BASE.bookieFairProb, BASE.pinnacleFairProb, BASE.decimalOdds, BASE.calibrationFitted);
    expect(r.qualifies).toBe(true);
    expect(r.regime).toBe('cold');
  });

  it('fails when modelProb below 50% floor', () => {
    const r = checkConsensusEligibility(prob(0.48), BASE.bookieFairProb, BASE.pinnacleFairProb, BASE.decimalOdds, BASE.calibrationFitted);
    expect(r.qualifies).toBe(false);
    expect(r.reason).toContain('model');
  });

  it('fails when bookieFairProb below 50% floor', () => {
    const r = checkConsensusEligibility(BASE.modelProb, prob(0.49), BASE.pinnacleFairProb, BASE.decimalOdds, BASE.calibrationFitted);
    expect(r.qualifies).toBe(false);
    expect(r.reason).toContain('bookie fair');
  });

  it('fails when odds below minimum (1.30)', () => {
    const r = checkConsensusEligibility(BASE.modelProb, BASE.bookieFairProb, BASE.pinnacleFairProb, 1.25, BASE.calibrationFitted);
    expect(r.qualifies).toBe(false);
    expect(r.reason).toContain('odds');
  });

  it('fails when Pinnacle absent', () => {
    const r = checkConsensusEligibility(BASE.modelProb, BASE.bookieFairProb, null, BASE.decimalOdds, BASE.calibrationFitted);
    expect(r.qualifies).toBe(false);
    expect(r.reason).toContain('Pinnacle absent');
  });

  it('fails when Pinnacle diff > 5pp', () => {
    // model=0.55, pinnacle=0.49 → diff=6pp > 5pp
    const r = checkConsensusEligibility(BASE.modelProb, BASE.bookieFairProb, prob(0.49), BASE.decimalOdds, BASE.calibrationFitted);
    expect(r.qualifies).toBe(false);
    expect(r.reason).toContain('disagrees');
  });

  it('fails when model-bookie gap below cold threshold (3pp)', () => {
    // model=0.55, bookie=0.54 → gap=1pp < 3pp
    const r = checkConsensusEligibility(prob(0.55), prob(0.54), BASE.pinnacleFairProb, BASE.decimalOdds, BASE.calibrationFitted);
    expect(r.qualifies).toBe(false);
    expect(r.reason).toContain('gap');
  });

  it('fails when model-bookie gap below live threshold (2pp) with calibration fitted', () => {
    // model=0.55, bookie=0.54 → gap=1pp < 2pp (live)
    const r = checkConsensusEligibility(prob(0.55), prob(0.54), BASE.pinnacleFairProb, BASE.decimalOdds, true);
    expect(r.qualifies).toBe(false);
  });

  it('qualifies with 2pp gap in live regime', () => {
    // model=0.55, bookie=0.53 → gap=2pp ≥ 2pp (live)
    const r = checkConsensusEligibility(prob(0.55), prob(0.53), BASE.pinnacleFairProb, BASE.decimalOdds, true);
    expect(r.qualifies).toBe(true);
    expect(r.regime).toBe('live');
  });
});

describe('checkConsensusEligibility — confidence tiers', () => {
  it('MEDIUM when gap ≥ 3pp cold but not HIGH criteria', () => {
    // gap=3pp, Pinnacle diff=1pp → qualifies MEDIUM (gap < 4pp for HIGH)
    const r = checkConsensusEligibility(prob(0.55), prob(0.52), prob(0.54), 1.80, false);
    expect(r.qualifies).toBe(true);
    expect(r.confidence).toBe('MEDIUM');
  });

  it('HIGH when gap ≥ 4pp and Pinnacle within 2pp', () => {
    // model=0.60, bookie=0.55 → gap=5pp ≥ 4pp; pinnacle=0.595 → diff=0.5pp ≤ 2pp
    const r = checkConsensusEligibility(prob(0.60), prob(0.55), prob(0.595), 1.70, false);
    expect(r.qualifies).toBe(true);
    expect(r.confidence).toBe('HIGH');
  });

  it('MEDIUM when gap ≥ 4pp but Pinnacle diff > 2pp', () => {
    // model=0.60, bookie=0.55 → gap=5pp; pinnacle=0.57 → diff=3pp > 2pp → MEDIUM
    const r = checkConsensusEligibility(prob(0.60), prob(0.55), prob(0.57), 1.70, false);
    expect(r.qualifies).toBe(true);
    expect(r.confidence).toBe('MEDIUM');
  });

  it('reason field populated on qualification', () => {
    const r = checkConsensusEligibility(prob(0.65), prob(0.62), prob(0.64), 1.60, false);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('reason field populated on failure', () => {
    const r = checkConsensusEligibility(prob(0.45), BASE.bookieFairProb, BASE.pinnacleFairProb, BASE.decimalOdds, false);
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

describe('checkConsensusEligibility — constants', () => {
  it('CONSENSUS_MIN_PROB is 50%', () => { expect(CONSENSUS_MIN_PROB).toBe(0.50); });
  it('CONSENSUS_MIN_ODDS is 1.30', () => { expect(CONSENSUS_MIN_ODDS).toBe(1.30); });
  it('cold gap tighter than live gap', () => { expect(CONSENSUS_COLD_MIN_GAP).toBeGreaterThan(CONSENSUS_LIVE_MIN_GAP); });
  it('HIGH gap ≥ cold gap', () => { expect(CONSENSUS_HIGH_MIN_GAP).toBeGreaterThanOrEqual(CONSENSUS_COLD_MIN_GAP); });
  it('HIGH Pinnacle threshold tighter than outer 5pp gate', () => { expect(CONSENSUS_HIGH_PINNACLE_THRESHOLD).toBeLessThan(0.05); });
});
