/**
 * Isotonic regression calibration (pool adjacent violators algorithm).
 *
 * Takes (predicted_prob, actual_outcome) pairs, fits a monotone step function.
 * Requires ≥ MIN_SAMPLES; below that, returns identity (no calibration).
 */

const MIN_SAMPLES = 200;

export interface CalibrationPoint {
  lo: number;
  hi: number;
  calibrated: number;
  n: number;
}

export interface CalibrationModel {
  league: string;
  market: string;
  points: CalibrationPoint[];
  nSamples: number;
  fitted: boolean;
  brierBefore: number;
  brierAfter: number;
}

/** Pool adjacent violators (PAV) isotonic regression. */
function isotonic(pairs: Array<{ p: number; y: number }>): Array<{ p: number; q: number }> {
  // Sort by predicted probability
  const sorted = [...pairs].sort((a, b) => a.p - b.p);

  // Each block: { sumY, n, avgP }
  const blocks: Array<{ sumY: number; n: number; sumP: number }> = sorted.map((x) => ({
    sumY: x.y,
    n: 1,
    sumP: x.p,
  }));

  // PAV: merge adjacent blocks if monotonicity is violated
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      const curr = blocks[i]!;
      const next = blocks[i + 1]!;
      if (curr.sumY / curr.n > next.sumY / next.n) {
        // Merge
        blocks.splice(i, 2, {
          sumY: curr.sumY + next.sumY,
          n: curr.n + next.n,
          sumP: curr.sumP + next.sumP,
        });
        changed = true;
        break;
      }
    }
  }

  // Expand blocks back to individual points
  const result: Array<{ p: number; q: number }> = [];
  let idx = 0;
  for (const b of blocks) {
    const q = b.sumY / b.n;
    for (let j = 0; j < b.n; j++) {
      result.push({ p: sorted[idx]!.p, q });
      idx++;
    }
  }
  return result;
}

function brierScore(pairs: Array<{ p: number; y: number }>): number {
  const sum = pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0);
  return sum / pairs.length;
}

/** Look up calibrated probability for a new predicted probability. */
function lookupCalibrated(points: CalibrationPoint[], p: number): number {
  if (points.length === 0) return p;
  // Find the bin that contains p
  for (const pt of points) {
    if (p >= pt.lo && p <= pt.hi) return pt.calibrated;
  }
  // Extrapolate: clamp to nearest endpoint
  if (p < points[0]!.lo) return points[0]!.calibrated;
  return points[points.length - 1]!.calibrated;
}

export function fitCalibration(
  league: string,
  market: string,
  pairs: Array<{ predicted: number; actual: number }>,
): CalibrationModel {
  const nSamples = pairs.length;
  const brierBefore = brierScore(pairs.map((x) => ({ p: x.predicted, y: x.actual })));

  if (nSamples < MIN_SAMPLES) {
    console.log(
      `[calibration] ${league}/${market}: only ${nSamples} samples — identity (need ≥${MIN_SAMPLES})`,
    );
    return {
      league, market, points: [], nSamples, fitted: false,
      brierBefore, brierAfter: brierBefore,
    };
  }

  const isoResult = isotonic(pairs.map((x) => ({ p: x.predicted, y: x.actual })));

  // Build bin structure (unique calibrated values)
  const pointsMap = new Map<number, { lo: number; hi: number; n: number }>();
  for (const { p, q } of isoResult) {
    if (!pointsMap.has(q)) {
      pointsMap.set(q, { lo: p, hi: p, n: 0 });
    }
    const bin = pointsMap.get(q)!;
    bin.lo = Math.min(bin.lo, p);
    bin.hi = Math.max(bin.hi, p);
    bin.n++;
  }

  const points: CalibrationPoint[] = [...pointsMap.entries()].map(([calibrated, b]) => ({
    lo: b.lo,
    hi: b.hi,
    calibrated,
    n: b.n,
  }));
  points.sort((a, b) => a.lo - b.lo);

  const brierAfter = brierScore(
    pairs.map((x) => ({ p: lookupCalibrated(points, x.predicted), y: x.actual })),
  );

  return { league, market, points, nSamples, fitted: true, brierBefore, brierAfter };
}

export function applyCalibration(model: CalibrationModel, p: number): number {
  if (!model.fitted || model.points.length === 0) return p;
  return lookupCalibrated(model.points, p);
}

export { lookupCalibrated };
