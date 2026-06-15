import { type EdgePct, type Probability, edgePct } from '../types/branded.js';

/**
 * Calibration regime determines which edge threshold applies.
 *
 * COLD:  isotonic calibration not yet fitted (< 200 samples).
 *        Use tighter edge threshold to compensate for known overconfidence.
 * LIVE:  isotonic is fitted and active.
 */
export type CalibrationRegime = 'cold' | 'live';

/** Edge thresholds — Standard strategy */
export const CALIBRATION_COLD_MIN_EDGE = 0.05;  // 5% — tighter, compensates for overconfidence
export const CALIBRATION_LIVE_MIN_EDGE = 0.02;  // 2% — normal post-calibration threshold
export const HIGH_MIN_EDGE = 0.05;               // HIGH always requires 5%+ edge
export const HIGH_PINNACLE_AGREEMENT_THRESHOLD = 0.03; // Pinnacle fair prob within 3pp of model

/** Consensus Value strategy thresholds */
export const CONSENSUS_MIN_PROB = 0.50;                // Both model and bookie must agree outcome is likely
export const CONSENSUS_MIN_ODDS = 1.30;                // Below this the bookmaker margin eats the edge
export const CONSENSUS_COLD_MIN_GAP = 0.03;            // 3pp model > bookie gap (cold regime)
export const CONSENSUS_LIVE_MIN_GAP = 0.02;            // 2pp gap (live regime, calibration active)
export const CONSENSUS_HIGH_MIN_GAP = 0.04;            // HIGH: ≥4pp gap
export const CONSENSUS_HIGH_PINNACLE_THRESHOLD = 0.02; // HIGH: Pinnacle within 2pp of model
export const CONSENSUS_HIGH_MIN_SAMPLE = 50;           // HIGH: sample > 50 with positive CLV (checked in pipeline)

/**
 * Pinnacle agreement check.
 *
 * Returns true if Pinnacle's fair probability is within 3pp of model probability —
 * meaning the sharp market roughly agrees with our model.
 *
 * If Pinnacle is absent, HIGH confidence is unreachable (returns false, caller caps at MEDIUM).
 */
export function pinnacleAgreement(
  modelProb: Probability,
  pinnacleFairProb: Probability | null,
): boolean {
  if (pinnacleFairProb === null) return false;
  return Math.abs(modelProb - pinnacleFairProb) <= HIGH_PINNACLE_AGREEMENT_THRESHOLD;
}

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ConfidenceResult {
  confidence: Confidence;
  regime: CalibrationRegime;
  pinnaclePresent: boolean;
  pinnacleAgreed: boolean;
  /** Why this tier was assigned — for audit log */
  reason: string;
}

/**
 * Assign confidence tier.
 *
 * HIGH:
 *   - Edge ≥ 5% (both regimes)
 *   - Pinnacle present AND agreement (|modelProb - pinnFairProb| ≤ 3pp)
 *   If Pinnacle absent: cap at MEDIUM regardless of edge
 *
 * MEDIUM:
 *   - Edge ≥ min threshold (5% cold / 2% live) AND edge < 5%
 *   - OR edge ≥ 5% but Pinnacle absent or disagrees
 *
 * LOW:
 *   - Edge below minimum threshold
 */
export function assignConfidence(
  edge: EdgePct,
  modelProb: Probability,
  pinnacleFairProb: Probability | null,
  calibrationFitted: boolean,
): ConfidenceResult {
  const regime: CalibrationRegime = calibrationFitted ? 'live' : 'cold';
  const minEdge = regime === 'cold' ? CALIBRATION_COLD_MIN_EDGE : CALIBRATION_LIVE_MIN_EDGE;
  const pinnaclePresent = pinnacleFairProb !== null;
  const pinnacleAgreed = pinnacleAgreement(modelProb, pinnacleFairProb);

  if (edge < minEdge) {
    return {
      confidence: 'LOW',
      regime,
      pinnaclePresent,
      pinnacleAgreed: false,
      reason: `edge ${(edge * 100).toFixed(2)}% < min ${(minEdge * 100).toFixed(0)}% (${regime})`,
    };
  }

  if (edge >= HIGH_MIN_EDGE && pinnaclePresent && pinnacleAgreed) {
    return {
      confidence: 'HIGH',
      regime,
      pinnaclePresent,
      pinnacleAgreed,
      reason: `edge ${(edge * 100).toFixed(2)}% ≥ 5%, Pinnacle agrees (Δ${(Math.abs(modelProb - pinnacleFairProb!) * 100).toFixed(1)}pp)`,
    };
  }

  // MEDIUM — but document why it's not HIGH
  let reason: string;
  if (edge >= HIGH_MIN_EDGE && !pinnaclePresent) {
    reason = `edge ${(edge * 100).toFixed(2)}% ≥ 5% but Pinnacle absent — capped at MEDIUM`;
  } else if (edge >= HIGH_MIN_EDGE && !pinnacleAgreed) {
    reason = `edge ${(edge * 100).toFixed(2)}% ≥ 5% but Pinnacle disagrees (Δ${(Math.abs(modelProb - pinnacleFairProb!) * 100).toFixed(1)}pp > 3pp)`;
  } else {
    reason = `edge ${(edge * 100).toFixed(2)}% ≥ min ${(minEdge * 100).toFixed(0)}% but < 5% (${regime})`;
  }

  return { confidence: 'MEDIUM', regime, pinnaclePresent, pinnacleAgreed, reason };
}

// ─── Consensus Value strategy ────────────────────────────────────────────────

export interface ConsensusResult {
  qualifies: boolean;
  confidence: Confidence;
  regime: CalibrationRegime;
  pinnaclePresent: boolean;
  reason: string;
}

/**
 * Check whether a selection qualifies under the Consensus Value strategy.
 *
 * Consensus Value: both model AND de-vigged bookie agree the outcome is
 * likely (≥60%), but the model is somewhat more confident. Surfaces
 * high-probability outcomes (favorites, Over 1.5) with smaller edges (2-4%).
 *
 * Qualification requires ALL of:
 *   1. modelProb ≥ 60%
 *   2. bookieFairProb ≥ 60%
 *   3. modelProb ≥ bookieFairProb + threshold (3pp cold / 2pp live)
 *   4. decimalOdds ≥ 1.30
 *   5. Pinnacle present and within 5pp of model (sharp confirmation)
 *
 * Confidence tiers:
 *   HIGH:   gap ≥ 4pp, Pinnacle within 2pp
 *   MEDIUM: gap ≥ threshold, Pinnacle within 5pp
 */
export function checkConsensusEligibility(
  modelProb: Probability,
  bookieFairProb: Probability,
  pinnacleFairProb: Probability | null,
  decimalOdds: number,
  calibrationFitted: boolean,
): ConsensusResult {
  const regime: CalibrationRegime = calibrationFitted ? 'live' : 'cold';
  const minGap = regime === 'cold' ? CONSENSUS_COLD_MIN_GAP : CONSENSUS_LIVE_MIN_GAP;
  const pinnaclePresent = pinnacleFairProb !== null;
  const gap = modelProb - bookieFairProb;
  const pinnDiff = pinnaclePresent ? Math.abs(modelProb - pinnacleFairProb!) : Infinity;

  const fail = (reason: string): ConsensusResult =>
    ({ qualifies: false, confidence: 'LOW', regime, pinnaclePresent, reason });

  if (modelProb < CONSENSUS_MIN_PROB)
    return fail(`model ${(modelProb * 100).toFixed(1)}% < ${(CONSENSUS_MIN_PROB * 100).toFixed(0)}% consensus floor`);

  if (bookieFairProb < CONSENSUS_MIN_PROB)
    return fail(`bookie fair ${(bookieFairProb * 100).toFixed(1)}% < ${(CONSENSUS_MIN_PROB * 100).toFixed(0)}% consensus floor`);

  if (decimalOdds < CONSENSUS_MIN_ODDS)
    return fail(`odds ${decimalOdds} < ${CONSENSUS_MIN_ODDS} minimum (margin too large)`);

  if (!pinnaclePresent)
    return fail('Pinnacle absent — sharp confirmation required for Consensus Value');

  if (pinnDiff > 0.05)
    return fail(`Pinnacle disagrees: Δ${(pinnDiff * 100).toFixed(1)}pp > 5pp confirmation threshold`);

  if (gap < minGap)
    return fail(`model-bookie gap ${(gap * 100).toFixed(2)}pp < min ${(minGap * 100).toFixed(0)}pp (${regime})`);

  // Qualifies — assign confidence tier
  if (gap >= CONSENSUS_HIGH_MIN_GAP && pinnDiff <= CONSENSUS_HIGH_PINNACLE_THRESHOLD) {
    return {
      qualifies: true,
      confidence: 'HIGH',
      regime,
      pinnaclePresent,
      reason: `Consensus HIGH: gap ${(gap * 100).toFixed(2)}pp ≥ 4pp, Pinnacle Δ${(pinnDiff * 100).toFixed(1)}pp ≤ 2pp`,
    };
  }

  return {
    qualifies: true,
    confidence: 'MEDIUM',
    regime,
    pinnaclePresent,
    reason: `Consensus MEDIUM: gap ${(gap * 100).toFixed(2)}pp ≥ ${(minGap * 100).toFixed(0)}pp, Pinnacle within 5pp`,
  };
}
