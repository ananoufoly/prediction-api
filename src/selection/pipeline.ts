import { prisma } from '../db.js';
import { computeXgRatings } from '../model/xgRatings.js';
import { applyEloPriors } from '../model/elo.js';
import { computeMatchProbsDC, fitRho, type TrainingMatch } from '../model/dixonColes.js';
import { expectedGoals } from '../model/poisson.js';
import { type CalibrationModel, fitCalibration } from '../model/calibration.js';
import { shinDevig } from '../math/shin.js';
import { computeEdge, applyModelCalibration, type MarketOdds } from './edge.js';
import { assignConfidence, checkConsensusEligibility, type ConfidenceResult } from './confidence.js';
import { computeKelly } from './kelly.js';
import { prob, odds as brandOdds, edgePct } from '../types/branded.js';
import { normalizeTeam } from '../ingestion/teamNorm.js';
import { getLeagueStandings } from '../ingestion/standings.js';
import { evaluateMatchMotivation, type MotivationFlag } from '../model/motivation.js';

const DEFAULT_BANKROLL = 1000;

export type SelectionStrategy = 'STANDARD' | 'CONSENSUS';

export interface SelectionCandidate {
  matchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: Date;
  market: string;
  outcome: string;
  modelProb: number;
  pinnacleFairProb: number | null;
  bookieFairProb: number;
  bookmaker: string;
  decimalOdds: number;
  edgePct: number;
  kellyFraction: number;
  recommendedStake: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  confidenceDetail: ConfidenceResult;
  strategy: SelectionStrategy;
  motivationHome: MotivationFlag;
  motivationAway: MotivationFlag;
  motivationSuppressed: boolean;
  motivationReason: string;
}

async function loadCalibrationModels(league: string): Promise<Map<string, CalibrationModel>> {
  const points = await prisma.calibrationPoint.findMany({
    where: { match: { league }, modelVersion: 'v1' },
    orderBy: { matchDate: 'asc' },
  });

  const marketMap = new Map<string, Array<{ predicted: number; actual: number }>>();
  for (const p of points) {
    const key = p.market;
    if (!marketMap.has(key)) marketMap.set(key, []);
    marketMap.get(key)!.push({ predicted: p.predictedProb, actual: p.actualOutcome });
  }

  const models = new Map<string, CalibrationModel>();
  for (const [market, pairs] of marketMap) {
    models.set(market, fitCalibration(league, market, pairs));
  }
  return models;
}

/**
 * Generate selection candidates for all upcoming matches in a league.
 *
 * Flow:
 *   1. Load xG ratings + Elo priors
 *   2. Fit ρ from recent history
 *   3. Load calibration models (may be cold)
 *   4. For each upcoming match with fresh odds snapshots:
 *      a. Predict probabilities (DC + goalConversionFactor)
 *      b. Apply calibration if fitted
 *      c. De-vig Pinnacle (or best available) → fair odds
 *      d. Compute edge
 *      e. Assign confidence (Pinnacle-gated for HIGH)
 *      f. Quarter-Kelly stake
 */
export async function generateSelections(
  league: string,
  bankroll = DEFAULT_BANKROLL,
): Promise<SelectionCandidate[]> {
  const lr = await computeXgRatings(league);
  await applyEloPriors(league, lr.teams);

  // Fit ρ from last 500 finished matches
  const recentMatches = await prisma.match.findMany({
    where: { league, status: 'FINAL', homeGoals: { not: null } },
    orderBy: { kickoffUtc: 'desc' },
    take: 500,
  });

  const training: TrainingMatch[] = [];
  for (const m of recentMatches) {
    const home = lr.teams.get(m.homeTeam);
    const away = lr.teams.get(m.awayTeam);
    if (!home || !away) continue;
    const { lambdaHome, lambdaAway } = expectedGoals(
      home.attack, home.defense, away.attack, away.defense,
      lr.leagueAvgAttack, undefined, lr.goalConversionFactor,
    );
    training.push({ lambdaHome, lambdaAway, homeGoals: m.homeGoals!, awayGoals: m.awayGoals! });
  }

  const rho = training.length >= 50 ? fitRho(training).rho : -0.1;

  // Load calibration
  const calibrationModels = await loadCalibrationModels(league);

  // Load standings for motivation analysis (soft fail — don't block picks if unavailable)
  const standings = await getLeagueStandings(league).catch(() => new Map());

  // Upcoming matches with odds in next 7 days
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);

  const upcomingMatches = await prisma.match.findMany({
    where: {
      league,
      status: 'SCHEDULED',
      kickoffUtc: { gte: now, lte: weekAhead },
    },
    include: {
      oddsSnapshots: {
        where: {
          isClosing: false,
          fetchedAt: { gte: new Date(now.getTime() - 12 * 3600_000) }, // last 12h
        },
        orderBy: { fetchedAt: 'desc' },
      },
    },
  });

  const candidates: SelectionCandidate[] = [];

  for (const match of upcomingMatches) {
    // Ratings map is keyed by historical names — try direct then normalized
    const homeRating = lr.teams.get(match.homeTeam)
      ?? lr.teams.get(normalizeTeam(match.homeTeam));
    const awayRating = lr.teams.get(match.awayTeam)
      ?? lr.teams.get(normalizeTeam(match.awayTeam));

    if (!homeRating || !awayRating) continue;
    if (match.oddsSnapshots.length === 0) continue;

    // Motivation check — try normalized names for standings lookup
    const homeKey = standings.has(match.homeTeam) ? match.homeTeam : normalizeTeam(match.homeTeam);
    const awayKey = standings.has(match.awayTeam) ? match.awayTeam : normalizeTeam(match.awayTeam);
    const motivation = evaluateMatchMotivation(homeKey, awayKey, standings);

    const probs = computeMatchProbsDC(
      homeRating.attack, homeRating.defense,
      awayRating.attack, awayRating.defense,
      lr.leagueAvgAttack, rho, undefined, lr.goalConversionFactor,
    );

    // Odds API outcome names may differ from historical team names — normalize both
    const homeNorm = normalizeTeam(match.homeTeam);
    const awayNorm = normalizeTeam(match.awayTeam);

    // Market → model prob map: keyed by both raw and normalized name for lookup resilience
    const modelProbByOutcome: Record<string, number> = {
      [match.homeTeam]: probs.pHome,
      [homeNorm]: probs.pHome,
      'Draw': probs.pDraw,
      [match.awayTeam]: probs.pAway,
      [awayNorm]: probs.pAway,
      'Over 2.5': probs.pOver25,
      'Under 2.5': 1 - probs.pOver25,
    };

    // Deduplicate to latest snapshot per bookmaker+market+outcome (snapshots ordered desc by fetchedAt)
    const latestSnap = new Map<string, typeof match.oddsSnapshots[number]>();
    for (const snap of match.oddsSnapshots) {
      const key = `${snap.bookmaker}:${snap.market}:${snap.outcome}`;
      if (!latestSnap.has(key)) latestSnap.set(key, snap); // first = latest (desc order)
    }

    // Group odds by market
    const marketGroups = new Map<string, MarketOdds[]>();
    for (const snap of latestSnap.values()) {
      const key = snap.market;
      if (!marketGroups.has(key)) marketGroups.set(key, []);
      marketGroups.get(key)!.push({
        bookmaker: snap.bookmaker,
        market: snap.market,
        outcome: snap.outcome,
        decimalOdds: brandOdds(snap.decimalOdds),
      });
    }

    for (const [market, allOdds] of marketGroups) {
      const marketName = market === 'h2h' ? 'h2h' : market;
      const calModel = calibrationModels.get(marketName) ?? null;
      const calibrationFitted = calModel?.fitted ?? false;

      // Group by bookmaker — Shin devig requires a single bookmaker's complete market
      const byBookmaker = new Map<string, MarketOdds[]>();
      for (const o of allOdds) {
        if (!byBookmaker.has(o.bookmaker)) byBookmaker.set(o.bookmaker, []);
        byBookmaker.get(o.bookmaker)!.push(o);
      }

      // Pre-compute Pinnacle fair probs (used for confidence gate on all bookmakers)
      const pinnacleOdds = byBookmaker.get('pinnacle') ?? [];
      const pinnaclePresent = pinnacleOdds.length >= 2;
      const pinnFairByOutcome = new Map<string, number>();
      if (pinnaclePresent) {
        try {
          const pinnShin = shinDevig(pinnacleOdds.map((o) => o.decimalOdds));
          pinnacleOdds.forEach((o, i) => {
            const p = pinnShin.probabilities[i];
            if (p !== undefined) pinnFairByOutcome.set(o.outcome, p);
          });
        } catch { /* use null */ }
      }

      for (const [bookmaker, bookOdds] of byBookmaker) {
        // De-vig this bookmaker's market
        let bookFairByOutcome: Map<string, number>;
        try {
          const shin = shinDevig(bookOdds.map((o) => o.decimalOdds));
          bookFairByOutcome = new Map(bookOdds.map((o, i) => [o.outcome, shin.probabilities[i] ?? (1 / o.decimalOdds)]));
        } catch {
          bookFairByOutcome = new Map(bookOdds.map((o) => [o.outcome, 1 / o.decimalOdds]));
        }

        for (const odd of bookOdds) {
          const rawModelProb = modelProbByOutcome[odd.outcome];
          if (rawModelProb === undefined) continue;

          const calibratedProb = applyModelCalibration(rawModelProb, calModel);
          const bookieFairProb = bookFairByOutcome.get(odd.outcome) ?? (1 / odd.decimalOdds);
          const pinnFair = pinnFairByOutcome.get(odd.outcome) ?? null;

          const edge = computeEdge(calibratedProb, prob(bookieFairProb));

          // ── Standard strategy ───────────────────────────────────────────
          const standardConf = assignConfidence(
            edgePct(edge),
            calibratedProb,
            pinnFair !== null ? prob(pinnFair) : null,
            calibrationFitted,
          );

          const motivationFields = {
            motivationHome: motivation.home.flag,
            motivationAway: motivation.away.flag,
            motivationSuppressed: motivation.suppress,
            motivationReason: motivation.reason,
          };

          // Skip suppressed matches — one or both teams have nothing to play for
          if (motivation.suppress) { console.log(`[motivation] SUPPRESSED: ${match.homeTeam} vs ${match.awayTeam} | ${motivation.reason}`); continue; }

          if (standardConf.confidence !== 'LOW' && edge >= 0.03 && edge <= 0.50) {
            const kelly = computeKelly(calibratedProb, odd.decimalOdds, bankroll);
            if (kelly.recommendedStakePct > 0) {
              candidates.push({
                matchId: match.id,
                league,
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                kickoffUtc: match.kickoffUtc,
                market: marketName,
                outcome: odd.outcome,
                modelProb: calibratedProb,
                pinnacleFairProb: pinnFair,
                bookieFairProb,
                bookmaker,
                decimalOdds: odd.decimalOdds,
                edgePct: edge,
                kellyFraction: kelly.quarterKelly,
                recommendedStake: kelly.recommendedStake,
                confidence: standardConf.confidence,
                confidenceDetail: standardConf,
                strategy: 'STANDARD',
                ...motivationFields,
              });
            }
          }

          // ── Consensus Value strategy ────────────────────────────────────
          const consensusResult = checkConsensusEligibility(
            calibratedProb,
            prob(bookieFairProb),
            pinnFair !== null ? prob(pinnFair) : null,
            odd.decimalOdds,
            calibrationFitted,
          );

          if (consensusResult.qualifies && edge >= 0.03 && edge <= 0.50) {
            const kelly = computeKelly(calibratedProb, odd.decimalOdds, bankroll);
            if (kelly.recommendedStakePct > 0) {
              candidates.push({
                matchId: match.id,
                league,
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                kickoffUtc: match.kickoffUtc,
                market: marketName,
                outcome: odd.outcome,
                modelProb: calibratedProb,
                pinnacleFairProb: pinnFair,
                bookieFairProb,
                bookmaker,
                decimalOdds: odd.decimalOdds,
                edgePct: edge,
                kellyFraction: kelly.quarterKelly,
                recommendedStake: kelly.recommendedStake,
                confidence: consensusResult.confidence,
                confidenceDetail: {
                  confidence: consensusResult.confidence,
                  regime: consensusResult.regime,
                  pinnaclePresent: consensusResult.pinnaclePresent,
                  pinnacleAgreed: true,
                  reason: consensusResult.reason,
                },
                strategy: 'CONSENSUS',
                ...motivationFields,
              });
            }
          }
        }
      }
    }
  }

  // Deduplicate: keep highest-edge candidate per match+market+outcome+strategy
  // Standard and Consensus are distinct entries (different Kelly sizing, different tracking)
  const deduped = new Map<string, SelectionCandidate>();
  for (const c of candidates) {
    const key = `${c.matchId}:${c.market}:${c.outcome}:${c.strategy}`;
    const existing = deduped.get(key);
    if (!existing || c.edgePct > existing.edgePct) deduped.set(key, c);
  }

  return [...deduped.values()].sort((a, b) => b.edgePct - a.edgePct);
}

/**
 * Persist a selection candidate to the DB as a PAPER bet.
 */
export async function persistSelection(
  candidate: SelectionCandidate,
) {
  return prisma.selection.create({
    data: {
      matchId: candidate.matchId,
      market: candidate.market,
      outcome: candidate.outcome,
      modelProb: candidate.modelProb,
      pinnacleFairProb: candidate.pinnacleFairProb,
      bookieFairProb: candidate.bookieFairProb,
      bookmaker: candidate.bookmaker,
      oddsAtSelection: candidate.decimalOdds,
      edgePct: candidate.edgePct,
      kellyFraction: candidate.kellyFraction,
      recommendedStake: candidate.recommendedStake,
      confidence: candidate.confidence,
      status: 'PAPER',
      source: 'MODEL',
      selectionStrategy: candidate.strategy,
    },
  });
}
