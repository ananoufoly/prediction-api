import { prisma } from '../../db.js';
import type { Sport } from '../util/runLog.js';

/** Bump when the feature definitions change so old rows are recomputed. */
export const FEATURE_VERSION = 'v1';

/** Mean of a numeric array, or null if empty. */
export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Whole days between two dates (a after b). */
export function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / 86_400_000);
}

/** Take the last `n` items (most recent assumed last). */
export function lastN<T>(xs: T[], n: number): T[] {
  return xs.slice(Math.max(0, xs.length - n));
}

/**
 * Standard ELO expected score for A vs B.
 * @param hfa home-field advantage in rating points added to A.
 */
export function eloExpected(ratingA: number, ratingB: number, hfa = 0): number {
  return 1 / (1 + 10 ** ((ratingB - (ratingA + hfa)) / 400));
}

/** ELO update for a single match outcome (scoreA = 1 win, 0 loss, 0.5 draw). */
export function eloUpdate(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  k: number,
  hfa = 0,
): [number, number] {
  const expA = eloExpected(ratingA, ratingB, hfa);
  const newA = ratingA + k * (scoreA - expA);
  const newB = ratingB + k * ((1 - scoreA) - (1 - expA));
  return [newA, newB];
}

export interface FeatureRow {
  matchKey: string;
  league: string | null;
  kickoffUtc: Date;
  homeTeam: string;
  awayTeam: string;
  features: Record<string, number | null>;
}

/**
 * Upsert a batch of computed feature rows for one sport. Idempotent on
 * (sport, matchKey, featureVersion). Returns the number of rows written.
 */
export async function persistFeatures(sport: Sport, rows: FeatureRow[]): Promise<number> {
  let written = 0;
  for (const r of rows) {
    await prisma.predictionFeature.upsert({
      where: {
        sport_matchKey_featureVersion: {
          sport,
          matchKey: r.matchKey,
          featureVersion: FEATURE_VERSION,
        },
      },
      create: {
        sport,
        matchKey: r.matchKey,
        league: r.league,
        kickoffUtc: r.kickoffUtc,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        features: r.features,
        featureVersion: FEATURE_VERSION,
      },
      update: {
        features: r.features,
        league: r.league,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        kickoffUtc: r.kickoffUtc,
        computedAt: new Date(),
      },
    });
    written++;
  }
  return written;
}
