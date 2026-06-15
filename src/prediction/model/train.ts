import { prisma } from '../../db.js';
import { runPython } from '../util/pyBridge.js';
import { FEATURE_VERSION } from '../features/shared.js';
import { MODEL_SPECS, type ModelSpec } from './specs.js';

/**
 * Phase 3 training orchestrator.
 *
 * Reads feature rows from prediction_features (the ONLY training input — no raw
 * re-fetch), sorts them chronologically (temporal integrity), and pipes them to
 * the sport's Python trainer via stdin. The trainer fits the model, serialises
 * an artifact to src/prediction/models/, and returns validation metrics, which
 * we persist as a ModelArtifact row.
 */

export interface TrainResult {
  sport: string;
  ok: boolean;
  modelType?: string;
  trainRows?: number;
  valRows?: number;
  valAccuracy?: number | null;
  valBrier?: number | null;
  note?: string;
  modelVersion?: string;
}

function modelVersion(sport: string): string {
  // Date-stamped, sortable. Use UTC date only (no Date.now noise in artifact names).
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${sport}-${FEATURE_VERSION}-${stamp}`;
}

interface MetricsOut {
  sport: string;
  ok: boolean;
  model_type?: string;
  train_rows?: number;
  val_rows?: number;
  val_accuracy?: number | null;
  val_brier?: number | null;
  val_brier_uncalibrated?: number | null;
  val_brier_calibrated?: number | null;
  calibrated?: boolean;
  calibration?: string;
  features?: string[];
  coefficients?: Record<string, number>;
  home_adv?: number;
  rho?: number;
  artifact_path?: string;
  note?: string;
}

async function trainSport(spec: ModelSpec): Promise<TrainResult> {
  // Pull feature rows, oldest first (trainer relies on chronological order).
  const rows = await prisma.predictionFeature.findMany({
    where: { sport: spec.sport, featureVersion: FEATURE_VERSION },
    orderBy: { kickoffUtc: 'asc' },
    select: { matchKey: true, kickoffUtc: true, homeTeam: true, awayTeam: true, league: true, features: true },
  });

  if (rows.length === 0) {
    return { sport: spec.sport, ok: false, note: 'no feature rows' };
  }

  const payload = JSON.stringify({
    rows: rows.map((r) => ({
      matchKey: r.matchKey,
      kickoffUtc: r.kickoffUtc.toISOString(),
      homeTeam: r.homeTeam,
      awayTeam: r.awayTeam,
      league: r.league,
      features: r.features,
    })),
    config: {
      sport: spec.sport,
      artifact: spec.artifact,
      target: spec.target,
      features: spec.features,
      margin_target: spec.marginTarget,
      symmetrize: spec.symmetrize,
    },
  });

  const { rows: out, stderr } = await runPython(spec.trainer, [], {
    input: payload,
    timeoutMs: 10 * 60_000,
  });

  const metrics = (out.find((o) => (o as MetricsOut).sport === spec.sport) ?? out[0]) as MetricsOut | undefined;
  if (!metrics) {
    return { sport: spec.sport, ok: false, note: `no metrics from trainer; stderr: ${stderr.slice(-300)}` };
  }
  if (!metrics.ok) {
    return { sport: spec.sport, ok: false, note: metrics.note ?? 'trainer reported not ok' };
  }

  const version = modelVersion(spec.sport);
  await prisma.modelArtifact.create({
    data: {
      sport: spec.sport,
      modelType: metrics.model_type ?? spec.kind,
      modelVersion: version,
      artifactPath: metrics.artifact_path ?? spec.artifact,
      featureVersion: FEATURE_VERSION,
      trainRows: metrics.train_rows ?? 0,
      valRows: metrics.val_rows ?? 0,
      valAccuracy: metrics.val_accuracy ?? null,
      valBrier: metrics.val_brier ?? null,
      features: {
        features: metrics.features ?? [],
        ...(metrics.coefficients ? { coefficients: metrics.coefficients } : {}),
        ...(metrics.home_adv != null ? { home_adv: metrics.home_adv } : {}),
        ...(metrics.rho != null ? { rho: metrics.rho } : {}),
        ...(metrics.calibration ? { calibration: metrics.calibration } : {}),
        ...(metrics.calibrated != null ? { calibrated: metrics.calibrated } : {}),
        ...(metrics.val_brier_uncalibrated != null ? { valBrierUncalibrated: metrics.val_brier_uncalibrated } : {}),
        ...(metrics.val_brier_calibrated != null ? { valBrierCalibrated: metrics.val_brier_calibrated } : {}),
      },
      ok: true,
    },
  });

  return {
    sport: spec.sport,
    ok: true,
    modelType: metrics.model_type ?? spec.kind,
    trainRows: metrics.train_rows ?? 0,
    valRows: metrics.val_rows ?? 0,
    valAccuracy: metrics.val_accuracy ?? null,
    valBrier: metrics.val_brier ?? null,
    modelVersion: version,
  };
}

/** Train one sport (or all of them if omitted). Rugby is never trained. */
export async function trainModels(sports?: string[]): Promise<TrainResult[]> {
  const targets = (sports ?? Object.keys(MODEL_SPECS)).filter((s) => MODEL_SPECS[s]);
  const results: TrainResult[] = [];
  for (const sport of targets) {
    try {
      results.push(await trainSport(MODEL_SPECS[sport]!));
    } catch (err) {
      results.push({ sport, ok: false, note: (err as Error).message });
    }
  }
  return results;
}
