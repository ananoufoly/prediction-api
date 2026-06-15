import { prisma } from '../../db.js';
import { runPython } from '../util/pyBridge.js';
import { FEATURE_VERSION } from '../features/shared.js';

/**
 * International models — fully separate from the club models. Weighted multinomial
 * (football_intl, 3-way w/ draw) / binary (rugby_intl) logistic regression with
 * match_weight as the sample weight. Train + predict via train_intl.py /
 * predict_intl.py. Predictions land in engine_predictions with the intl sport.
 */

interface IntlSpec {
  sport: 'football_intl' | 'rugby_intl';
  artifact: string;
  target: string;
  draw: boolean;
  features: string[];
}

export const INTL_SPECS: Record<string, IntlSpec> = {
  football_intl: {
    sport: 'football_intl',
    artifact: 'football_intl.pkl',
    target: 'target_outcome',
    draw: true,
    features: ['elo_diff', 'home_advantage', 'rest_diff', 'h2h_last_5'],
  },
  rugby_intl: {
    sport: 'rugby_intl',
    artifact: 'rugby_intl.pkl',
    target: 'target_home_win',
    draw: false,
    features: ['elo_diff', 'home_advantage', 'rest_diff', 'h2h_last_5'],
  },
};

function modelVersion(sport: string): string {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${sport}-${FEATURE_VERSION}-${stamp}`;
}

export interface IntlTrainResult {
  sport: string; ok: boolean; trainRows?: number; valRows?: number;
  valAccuracy?: number | null; valBrier?: number | null; note?: string;
}

export async function trainIntl(sportKey?: string): Promise<IntlTrainResult[]> {
  const targets = sportKey ? [sportKey] : Object.keys(INTL_SPECS);
  const results: IntlTrainResult[] = [];
  for (const key of targets) {
    const spec = INTL_SPECS[key];
    if (!spec) continue;
    const rows = await prisma.predictionFeature.findMany({
      where: { sport: spec.sport, featureVersion: FEATURE_VERSION },
      orderBy: { kickoffUtc: 'asc' },
      select: { matchKey: true, kickoffUtc: true, features: true },
    });
    if (rows.length === 0) { results.push({ sport: spec.sport, ok: false, note: 'no features' }); continue; }

    const payload = JSON.stringify({
      rows: rows.map((r) => ({ matchKey: r.matchKey, kickoffUtc: r.kickoffUtc.toISOString(), features: r.features })),
      config: { sport: spec.sport, artifact: spec.artifact, target: spec.target, draw: spec.draw, features: spec.features },
    });

    const { rows: out } = await runPython('train_intl.py', [], { input: payload, timeoutMs: 8 * 60_000 });
    const m = (out[0] ?? {}) as Record<string, unknown>;
    if (!m['ok']) { results.push({ sport: spec.sport, ok: false, note: String(m['note'] ?? 'trainer failed') }); continue; }

    const version = modelVersion(spec.sport);
    await prisma.modelArtifact.create({
      data: {
        sport: spec.sport, modelType: 'logistic_weighted', modelVersion: version,
        artifactPath: String(m['artifact_path'] ?? spec.artifact), featureVersion: FEATURE_VERSION,
        trainRows: Number(m['train_rows'] ?? 0), valRows: Number(m['val_rows'] ?? 0),
        valAccuracy: (m['val_accuracy'] as number) ?? null, valBrier: (m['val_brier'] as number) ?? null,
        features: { features: spec.features }, ok: true,
      },
    });
    results.push({
      sport: spec.sport, ok: true, trainRows: Number(m['train_rows']), valRows: Number(m['val_rows']),
      valAccuracy: (m['val_accuracy'] as number) ?? null, valBrier: (m['val_brier'] as number) ?? null,
    });
  }
  return results;
}

interface IntlOut { matchKey: string; pHome: number; pDraw?: number; pAway: number }

function tier(p: number): 'high' | 'medium' | 'low' {
  if (p > 0.65) return 'high';
  if (p >= 0.5) return 'medium';
  return 'low';
}

export async function predictIntl(sportKey?: string): Promise<Record<string, number>> {
  const targets = sportKey ? [sportKey] : Object.keys(INTL_SPECS);
  const counts: Record<string, number> = {};
  const now = new Date();

  for (const key of targets) {
    const spec = INTL_SPECS[key];
    if (!spec) continue;
    const latest = await prisma.modelArtifact.findFirst({ where: { sport: spec.sport, ok: true }, orderBy: { trainedAt: 'desc' } });
    const version = latest?.modelVersion ?? `${spec.sport}-untrained`;

    const rows = await prisma.predictionFeature.findMany({
      where: { sport: spec.sport, featureVersion: FEATURE_VERSION },
      orderBy: { kickoffUtc: 'asc' },
      select: { matchKey: true, league: true, kickoffUtc: true, homeTeam: true, awayTeam: true, features: true },
    });
    if (rows.length === 0) { counts[spec.sport] = 0; continue; }

    const payload = JSON.stringify({
      artifact: spec.artifact,
      rows: rows.map((r) => ({ matchKey: r.matchKey, features: r.features })),
    });
    const { rows: out } = await runPython('predict_intl.py', [], { input: payload, timeoutMs: 5 * 60_000 });
    const byKey = new Map<string, IntlOut>();
    for (const o of out as IntlOut[]) byKey.set(o.matchKey, o);

    // Build all rows in memory, then bulk replace (delete + chunked createMany).
    const toWrite = [];
    for (const r of rows) {
      const o = byKey.get(r.matchKey);
      if (!o) continue;
      const pHome = o.pHome, pDraw = spec.draw ? (o.pDraw ?? 0) : null, pAway = o.pAway;
      const probs = spec.draw
        ? [{ k: 'home' as const, p: pHome }, { k: 'draw' as const, p: pDraw! }, { k: 'away' as const, p: pAway }]
        : [{ k: 'home' as const, p: pHome }, { k: 'away' as const, p: pAway }];
      const top = probs.reduce((a, b) => (b.p > a.p ? b : a));
      toWrite.push({
        sport: spec.sport, league: r.league, matchKey: r.matchKey, kickoffUtc: r.kickoffUtc,
        homeTeam: r.homeTeam, awayTeam: r.awayTeam, predictedOutcome: top.k,
        pHome, pDraw, pAway, expectedMargin: null, confidenceTier: tier(top.p), flag: null,
        featuresUsed: spec.features, modelVersion: version,
      });
    }
    await prisma.enginePrediction.deleteMany({ where: { sport: spec.sport, modelVersion: version } });
    const CHUNK = 1000;
    for (let i = 0; i < toWrite.length; i += CHUNK) {
      await prisma.enginePrediction.createMany({ skipDuplicates: true, data: toWrite.slice(i, i + CHUNK) });
    }
    counts[spec.sport] = toWrite.length;
  }
  return counts;
}
