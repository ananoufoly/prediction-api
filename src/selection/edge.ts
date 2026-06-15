import { type Probability, type DecimalOdds, type EdgePct, prob, edgePct } from '../types/branded.js';
import { shinDevig } from '../math/shin.js';
import { applyCalibration, type CalibrationModel } from '../model/calibration.js';

export interface MarketOdds {
  bookmaker: string;
  market: string;
  outcome: string;
  decimalOdds: DecimalOdds;
}

export interface FairProbResult {
  fairProb: Probability;
  method: 'shin' | 'proportional';
  pinnaclePresent: boolean;
}

/**
 * Derive fair probability for an outcome from Pinnacle odds (preferred)
 * or fall back to best available bookmaker.
 *
 * Pinnacle is the sharp reference: we use Shin de-vig on their odds.
 * If Pinnacle is absent, we still de-vig whatever odds are available,
 * but flag it so downstream can cap confidence at MEDIUM.
 */
export function deriveFairProb(
  market: string,
  outcome: string,
  allOdds: MarketOdds[],
): FairProbResult {
  const inMarket = allOdds.filter((o) => o.market === market);
  const pinnacleOdds = inMarket.filter((o) => o.bookmaker === 'pinnacle');
  const pinnaclePresent = pinnacleOdds.length >= 2; // need ≥2 outcomes to de-vig

  const sourceOdds = pinnaclePresent ? pinnacleOdds : inMarket;
  if (sourceOdds.length < 2) {
    // Not enough to de-vig — return a rough implied prob
    const raw = inMarket.find((o) => o.outcome === outcome);
    if (!raw) return { fairProb: prob(0), method: 'proportional', pinnaclePresent: false };
    return { fairProb: prob(1 / raw.decimalOdds), method: 'proportional', pinnaclePresent: false };
  }

  const decimalOddsArr = sourceOdds.map((o) => o.decimalOdds);
  const shin = shinDevig(decimalOddsArr);

  const idx = sourceOdds.findIndex((o) => o.outcome === outcome);
  if (idx === -1) return { fairProb: prob(0), method: shin.method, pinnaclePresent };

  return {
    fairProb: shin.probabilities[idx] ?? prob(0),
    method: shin.method,
    pinnaclePresent,
  };
}

/**
 * Compute edge for a selection.
 *
 * edge = modelProb * bookieFairOdds - 1
 *      = modelProb / bookieFairProb - 1
 *
 * Positive edge means model thinks outcome is more likely than the market implies.
 */
export function computeEdge(modelProb: Probability, bookieFairProb: Probability): EdgePct {
  if (bookieFairProb <= 0) return edgePct(-1);
  return edgePct(modelProb / bookieFairProb - 1);
}

/**
 * Apply calibration model to raw model probability.
 * If not fitted (calibration cold), returns identity.
 */
export function applyModelCalibration(
  rawProb: number,
  calibration: CalibrationModel | null,
): Probability {
  if (!calibration || !calibration.fitted) return prob(Math.max(0, Math.min(1, rawProb)));
  return prob(applyCalibration(calibration, rawProb));
}
