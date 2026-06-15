import { prisma } from '../../db.js';
import { runPython } from '../util/pyBridge.js';
import { FEATURE_VERSION } from '../features/shared.js';
import { MODEL_SPECS } from './specs.js';

/**
 * Phase 3/4 inference. Produces the unified prediction output object for matches
 * using the trained artifacts. Football uses Dixon-Coles (3-way with draw); the
 * other four are logistic (2-way, no draw). Rugby is skipped → insufficient_data.
 */

export interface EnginePrediction {
  sport: string;
  league: string | null;
  matchKey: string;
  kickoff: string;
  homeTeam: string;
  awayTeam: string;
  predictedOutcome: 'home' | 'away' | 'draw' | null;
  probabilities: { home: number; draw: number | null; away: number } | null;
  expectedMargin: number | null;
  confidenceTier: 'high' | 'medium' | 'low' | null;
  flag?: string;
  featuresUsed: string[];
  modelVersion: string;
  generatedAt: string;
}

function confidenceTier(topProb: number): 'high' | 'medium' | 'low' {
  if (topProb > 0.65) return 'high';
  if (topProb >= 0.50) return 'medium';
  return 'low';
}

async function latestVersion(sport: string): Promise<string> {
  const m = await prisma.modelArtifact.findFirst({
    where: { sport, ok: true },
    orderBy: { trainedAt: 'desc' },
  });
  return m?.modelVersion ?? `${sport}-${FEATURE_VERSION}-untrained`;
}

interface FeatureRowDb {
  matchKey: string;
  league: string | null;
  kickoffUtc: Date;
  homeTeam: string;
  awayTeam: string;
  features: unknown;
}

interface LogisticOut { matchKey: string; pHome: number; pAway: number; expectedMargin: number | null }
interface DcOut { matchKey: string; pHome?: number; pDraw?: number; pAway?: number; expectedHomeGoals?: number; expectedAwayGoals?: number; flag?: string }

/**
 * Generate predictions for the given sport's matches. By default predicts all
 * feature rows for the sport; pass `matchKeys` to restrict. Returns the output
 * objects and persists them to engine_predictions.
 */
export async function predictSport(sport: string, opts?: { matchKeys?: string[] }): Promise<EnginePrediction[]> {
  const now = new Date().toISOString();

  // Rugby: skipped by design.
  if (sport === 'rugby') {
    const rows = await prisma.predictionFeature.findMany({
      where: { sport: 'rugby', featureVersion: FEATURE_VERSION, ...(opts?.matchKeys ? { matchKey: { in: opts.matchKeys } } : {}) },
      select: { matchKey: true, league: true, kickoffUtc: true, homeTeam: true, awayTeam: true },
    });
    const out: EnginePrediction[] = rows.map((r) => ({
      sport: 'rugby', league: r.league, matchKey: r.matchKey, kickoff: r.kickoffUtc.toISOString(),
      homeTeam: r.homeTeam, awayTeam: r.awayTeam,
      predictedOutcome: null, probabilities: null, expectedMargin: null, confidenceTier: null,
      flag: 'insufficient_data', featuresUsed: [], modelVersion: 'rugby-skipped', generatedAt: now,
    }));
    await persist(out);
    return out;
  }

  const spec = MODEL_SPECS[sport];
  if (!spec) return [];

  const rows = (await prisma.predictionFeature.findMany({
    where: { sport, featureVersion: FEATURE_VERSION, ...(opts?.matchKeys ? { matchKey: { in: opts.matchKeys } } : {}) },
    orderBy: { kickoffUtc: 'asc' },
    select: { matchKey: true, league: true, kickoffUtc: true, homeTeam: true, awayTeam: true, features: true },
  })) as FeatureRowDb[];
  if (rows.length === 0) return [];

  const modelVersion = await latestVersion(sport);
  const payload = JSON.stringify({
    artifact: spec.artifact,
    rows: rows.map((r) => ({ matchKey: r.matchKey, homeTeam: r.homeTeam, awayTeam: r.awayTeam, features: r.features })),
  });

  const predictScript = spec.kind === 'dixon_coles' ? 'predict_dixon_coles.py' : 'predict_logistic.py';
  const { rows: out, stderr } = await runPython(predictScript, [], { input: payload, timeoutMs: 5 * 60_000 });
  if (stderr.trim()) console.error(`[predict:${sport}]`, stderr.trim().split('\n').slice(-2).join(' | '));

  const byKey = new Map<string, LogisticOut | DcOut>();
  for (const o of out as Array<LogisticOut | DcOut>) byKey.set(o.matchKey, o);

  const results: EnginePrediction[] = [];

  for (const r of rows) {
    const o = byKey.get(r.matchKey);
    const base = {
      sport, league: r.league, matchKey: r.matchKey, kickoff: r.kickoffUtc.toISOString(),
      homeTeam: r.homeTeam, awayTeam: r.awayTeam, featuresUsed: spec.features ?? ['attack', 'defence', 'home_adv', 'rho'],
      modelVersion, generatedAt: now,
    };

    if (!o || (o as DcOut).flag === 'unknown_team') {
      results.push({ ...base, predictedOutcome: null, probabilities: null, expectedMargin: null, confidenceTier: null, flag: (o as DcOut)?.flag ?? 'no_prediction' });
      continue;
    }

    // Staleness guard: a prediction built on form from long before kickoff (e.g.
    // a not-yet-started season with only prior-year data) is untrustworthy — the
    // rolling windows reflect a different competitive context. If either side's
    // last game was implausibly long ago, withhold the prediction rather than
    // emit a confident-but-meaningless probability.
    const feat = (r.features ?? {}) as Record<string, number | null>;
    const STALE_DAYS = 120; // longer than any normal in-season rest gap
    const homeRest = feat['home_rest_days'];
    const awayRest = feat['away_rest_days'];
    if ((homeRest != null && homeRest > STALE_DAYS) || (awayRest != null && awayRest > STALE_DAYS)) {
      results.push({ ...base, predictedOutcome: null, probabilities: null, expectedMargin: null, confidenceTier: null, flag: 'stale_form' });
      continue;
    }

    if (spec.kind === 'dixon_coles') {
      const d = o as DcOut;
      const pHome = d.pHome ?? 0, pDraw = d.pDraw ?? 0, pAway = d.pAway ?? 0;
      const probs = [{ k: 'home' as const, p: pHome }, { k: 'draw' as const, p: pDraw }, { k: 'away' as const, p: pAway }];
      const top = probs.reduce((a, b) => (b.p > a.p ? b : a));
      results.push({
        ...base,
        predictedOutcome: top.k,
        probabilities: { home: pHome, draw: pDraw, away: pAway },
        expectedMargin: d.expectedHomeGoals != null && d.expectedAwayGoals != null ? d.expectedHomeGoals - d.expectedAwayGoals : null,
        confidenceTier: confidenceTier(top.p),
      });
    } else {
      const l = o as LogisticOut;
      const pHome = l.pHome, pAway = l.pAway;
      const top = pHome >= pAway ? { k: 'home' as const, p: pHome } : { k: 'away' as const, p: pAway };
      results.push({
        ...base,
        predictedOutcome: top.k,
        probabilities: { home: pHome, draw: null, away: pAway },
        expectedMargin: l.expectedMargin ?? null,
        confidenceTier: confidenceTier(top.p),
      });
    }
  }

  await persist(results);
  return results;
}

async function persist(preds: EnginePrediction[]): Promise<void> {
  for (const p of preds) {
    await prisma.enginePrediction.upsert({
      where: { sport_matchKey_modelVersion: { sport: p.sport, matchKey: p.matchKey, modelVersion: p.modelVersion } },
      create: {
        sport: p.sport, league: p.league, matchKey: p.matchKey, kickoffUtc: new Date(p.kickoff),
        homeTeam: p.homeTeam, awayTeam: p.awayTeam, predictedOutcome: p.predictedOutcome,
        pHome: p.probabilities?.home ?? null, pDraw: p.probabilities?.draw ?? null, pAway: p.probabilities?.away ?? null,
        expectedMargin: p.expectedMargin, confidenceTier: p.confidenceTier, flag: p.flag ?? null,
        featuresUsed: p.featuresUsed, modelVersion: p.modelVersion,
      },
      update: {
        predictedOutcome: p.predictedOutcome,
        pHome: p.probabilities?.home ?? null, pDraw: p.probabilities?.draw ?? null, pAway: p.probabilities?.away ?? null,
        expectedMargin: p.expectedMargin, confidenceTier: p.confidenceTier, flag: p.flag ?? null,
        generatedAt: new Date(),
      },
    });
  }
}

/** Predict for all sports (rugby → insufficient_data). */
export async function predictAll(opts?: { matchKeys?: string[] }): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const sport of [...Object.keys(MODEL_SPECS), 'rugby']) {
    const preds = await predictSport(sport, opts);
    counts[sport] = preds.length;
  }
  return counts;
}
