import { Router } from 'express';
import { ALL_LEAGUES } from '../leagues.js';
import { prisma } from '../db.js';
import { computeXgRatings } from '../model/xgRatings.js';
import { applyEloPriors } from '../model/elo.js';
import { expectedGoals } from '../model/poisson.js';
import { fitRho, type TrainingMatch } from '../model/dixonColes.js';
import { computeLiveProbs, pBttsLive } from '../model/liveModel.js';
import { normalizeTeam } from '../ingestion/teamNorm.js';
import { shinDevig } from '../math/shin.js';
import { computeEdge } from '../selection/edge.js';
import { assignConfidence } from '../selection/confidence.js';
import { computeKelly } from '../selection/kelly.js';
import { prob, odds as brandOdds, edgePct } from '../types/branded.js';
import { getLeagueStandings } from '../ingestion/standings.js';
import { evaluateMatchMotivation } from '../model/motivation.js';

export const liveRouter = Router();

// GET /api/live/matches — all currently LIVE matches with updated model probs
liveRouter.get('/live/matches', async (_req, res) => {
  try {
    const leagues = [...ALL_LEAGUES];

    const liveMatches = await prisma.match.findMany({
      where: { status: 'LIVE', league: { in: leagues } },
      orderBy: { kickoffUtc: 'asc' },
    });

    if (liveMatches.length === 0) {
      res.json([]);
      return;
    }

    // Build ratings for each relevant league (cache by league)
    const ratingsByLeague = new Map<string, Awaited<ReturnType<typeof computeXgRatings>>>();
    const rhoByLeague = new Map<string, number>();

    const standingsByLeague = new Map<string, Awaited<ReturnType<typeof getLeagueStandings>>>();

    for (const league of [...new Set(liveMatches.map((m) => m.league))]) {
      const lr = await computeXgRatings(league);
      await applyEloPriors(league, lr.teams);
      ratingsByLeague.set(league, lr);
      standingsByLeague.set(league, await getLeagueStandings(league).catch(() => new Map()));

      const recent = await prisma.match.findMany({
        where: { league, status: 'FINAL', homeGoals: { not: null } },
        orderBy: { kickoffUtc: 'desc' },
        take: 500,
      });
      const training: TrainingMatch[] = [];
      for (const m of recent) {
        const home = lr.teams.get(m.homeTeam) ?? lr.teams.get(normalizeTeam(m.homeTeam));
        const away = lr.teams.get(m.awayTeam) ?? lr.teams.get(normalizeTeam(m.awayTeam));
        if (!home || !away) continue;
        const { lambdaHome, lambdaAway } = expectedGoals(
          home.attack, home.defense, away.attack, away.defense,
          lr.leagueAvgAttack, undefined, lr.goalConversionFactor,
        );
        training.push({ lambdaHome, lambdaAway, homeGoals: m.homeGoals!, awayGoals: m.awayGoals! });
      }
      rhoByLeague.set(league, training.length >= 50 ? fitRho(training).rho : -0.1);
    }

    const result = [];

    for (const match of liveMatches) {
      const lr = ratingsByLeague.get(match.league);
      if (!lr) continue;

      const rho = rhoByLeague.get(match.league) ?? -0.1;

      // Fall back to league-average rating for teams with no historical data (promoted clubs etc.)
      const leagueAvgRating = { team: 'avg', attack: 1.0, defense: 1.0, games: 0 };
      const homeRating = lr.teams.get(match.homeTeam) ?? lr.teams.get(normalizeTeam(match.homeTeam)) ?? leagueAvgRating;
      const awayRating = lr.teams.get(match.awayTeam) ?? lr.teams.get(normalizeTeam(match.awayTeam)) ?? leagueAvgRating;

      const { lambdaHome, lambdaAway } = expectedGoals(
        homeRating.attack, homeRating.defense,
        awayRating.attack, awayRating.defense,
        lr.leagueAvgAttack, undefined, lr.goalConversionFactor,
      );

      // Use ESPN-provided elapsed minutes (updated every 5min by cron); fall back to wall clock
      const now = new Date();
      const elapsedMinutes = match.elapsedMinutes !== null && match.elapsedMinutes !== undefined
        ? match.elapsedMinutes
        : Math.max(0, Math.floor((now.getTime() - match.kickoffUtc.getTime()) / 60_000));

      const state = {
        elapsedMinutes,
        homeGoals: match.homeGoals ?? 0,
        awayGoals: match.awayGoals ?? 0,
      };

      const liveProbs = computeLiveProbs(lambdaHome, lambdaAway, state, rho);
      const pBtts = pBttsLive(lambdaHome, lambdaAway, state, rho);

      const standings = standingsByLeague.get(match.league) ?? new Map();
      const homeKey = standings.has(match.homeTeam) ? match.homeTeam : normalizeTeam(match.homeTeam);
      const awayKey = standings.has(match.awayTeam) ? match.awayTeam : normalizeTeam(match.awayTeam);
      const motivation = evaluateMatchMotivation(homeKey, awayKey, standings);

      result.push({
        matchId: match.id,
        league: match.league,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        kickoffUtc: match.kickoffUtc,
        homeGoals: match.homeGoals ?? 0,
        awayGoals: match.awayGoals ?? 0,
        elapsedMinutes,
        liveProbs: {
          pHome: liveProbs.pHome,
          pDraw: liveProbs.pDraw,
          pAway: liveProbs.pAway,
          pOver25: liveProbs.pOver25,
          pBtts,
          remainingFraction: liveProbs.remainingFraction,
        },
        fullMatchLambda: { lambdaHome, lambdaAway },
        motivationHome: motivation.home.flag,
        motivationAway: motivation.away.flag,
        motivationReason: motivation.reason,
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/live/edge — given manual odds entry, compute live edge
// Body: { matchId, market, outcome, decimalOdds, elapsedMinutes, homeGoals, awayGoals }
liveRouter.post('/live/edge', async (req, res) => {
  try {
    const { matchId, market, outcome, decimalOdds, elapsedMinutes, homeGoals, awayGoals } =
      req.body as {
        matchId: string;
        market: string;
        outcome: string;
        decimalOdds: number;
        elapsedMinutes: number;
        homeGoals: number;
        awayGoals: number;
      };

    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });

    const lr = await computeXgRatings(match.league);
    await applyEloPriors(match.league, lr.teams);

    const leagueAvgRating = { team: 'avg', attack: 1.0, defense: 1.0, games: 0 };
    const homeRating = lr.teams.get(match.homeTeam) ?? lr.teams.get(normalizeTeam(match.homeTeam)) ?? leagueAvgRating;
    const awayRating = lr.teams.get(match.awayTeam) ?? lr.teams.get(normalizeTeam(match.awayTeam)) ?? leagueAvgRating;

    const { lambdaHome, lambdaAway } = expectedGoals(
      homeRating.attack, homeRating.defense,
      awayRating.attack, awayRating.defense,
      lr.leagueAvgAttack, undefined, lr.goalConversionFactor,
    );

    const recent = await prisma.match.findMany({
      where: { league: match.league, status: 'FINAL', homeGoals: { not: null } },
      orderBy: { kickoffUtc: 'desc' },
      take: 500,
    });
    const training: TrainingMatch[] = [];
    for (const m of recent) {
      const h = lr.teams.get(m.homeTeam) ?? lr.teams.get(normalizeTeam(m.homeTeam));
      const a = lr.teams.get(m.awayTeam) ?? lr.teams.get(normalizeTeam(m.awayTeam));
      if (!h || !a) continue;
      const eg = expectedGoals(h.attack, h.defense, a.attack, a.defense, lr.leagueAvgAttack, undefined, lr.goalConversionFactor);
      training.push({ lambdaHome: eg.lambdaHome, lambdaAway: eg.lambdaAway, homeGoals: m.homeGoals!, awayGoals: m.awayGoals! });
    }
    const rho = training.length >= 50 ? fitRho(training).rho : -0.1;

    const state = { elapsedMinutes, homeGoals, awayGoals };
    const liveProbs = computeLiveProbs(lambdaHome, lambdaAway, state, rho);
    const pBtts = pBttsLive(lambdaHome, lambdaAway, state, rho);

    const modelProbByOutcome: Record<string, number> = {
      [match.homeTeam]: liveProbs.pHome,
      [normalizeTeam(match.homeTeam)]: liveProbs.pHome,
      'Draw': liveProbs.pDraw,
      [match.awayTeam]: liveProbs.pAway,
      [normalizeTeam(match.awayTeam)]: liveProbs.pAway,
      'Over 2.5': liveProbs.pOver25,
      'Under 2.5': 1 - liveProbs.pOver25,
      'BTTS Yes': pBtts,
      'BTTS No': 1 - pBtts,
    };

    const modelProb = modelProbByOutcome[outcome];
    if (modelProb === undefined) {
      res.status(422).json({ error: `Unknown outcome: ${outcome}` });
      return;
    }

    // Bookie fair = 1/odds (single-sided entry, no devig needed)
    const bookieFairProb = 1 / decimalOdds;
    const edge = computeEdge(prob(modelProb), prob(bookieFairProb));
    const confidence = assignConfidence(edgePct(edge), prob(modelProb), null, false);
    const kelly = computeKelly(modelProb, decimalOdds, 1000);

    res.json({
      matchId,
      market,
      outcome,
      decimalOdds,
      modelProb,
      bookieFairProb,
      edge,
      confidence: confidence.confidence,
      reason: confidence.reason,
      recommendedStake: kelly.recommendedStake,
      liveProbs: {
        pHome: liveProbs.pHome,
        pDraw: liveProbs.pDraw,
        pAway: liveProbs.pAway,
        pOver25: liveProbs.pOver25,
        pBtts,
        remainingFraction: liveProbs.remainingFraction,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/live/selections — persist a live selection
liveRouter.post('/live/selections', async (req, res) => {
  try {
    const {
      matchId, market, outcome, modelProb, bookieFairProb,
      bookmaker, decimalOdds, edgePct: ep, kellyFraction,
      recommendedStake, confidence,
    } = req.body as {
      matchId: string; market: string; outcome: string;
      modelProb: number; bookieFairProb: number; bookmaker: string;
      decimalOdds: number; edgePct: number; kellyFraction: number;
      recommendedStake: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    };

    const sel = await prisma.selection.create({
      data: {
        matchId, market, outcome, modelProb,
        pinnacleFairProb: null,
        bookieFairProb, bookmaker,
        oddsAtSelection: decimalOdds,
        edgePct: ep, kellyFraction, recommendedStake,
        confidence,
        isLive: true,
        status: 'PAPER',
        source: 'MODEL',
      },
    });
    res.json(sel);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
