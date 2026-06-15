import { Router } from 'express';
import { prisma } from '../db.js';
import { remainingProviderBudget } from './util/budget.js';

/**
 * Prediction-engine routes, mounted under /api/prediction. Separate from the
 * edge model's routes. Phase 1 exposes data-pipeline health; later phases add
 * /predictions output.
 */
export const predictionRouter = Router();

predictionRouter.get('/prediction/status', async (_req, res) => {
  try {
    const [
      footballFixtures, footballLineups, tennisMatches,
      nbaGameLogs, nflTeamGames, nflInjuries,
      mlbTeamGames, mlbPitcherStats, rugbyMatches, rugbyStandings,
    ] = await Promise.all([
      prisma.footballFixture.count(),
      prisma.footballLineup.count(),
      prisma.tennisMatch.count(),
      prisma.nbaGameLog.count(),
      prisma.nflTeamGame.count(),
      prisma.nflInjury.count(),
      prisma.mlbTeamGame.count(),
      prisma.mlbPitcherStat.count(),
      prisma.rugbyMatch.count(),
      prisma.rugbyStanding.count(),
    ]);

    // Last ingestion run per sport.
    const sports = ['football', 'football_intl', 'tennis', 'nba', 'nfl', 'mlb', 'rugby', 'rugby_intl'];
    const lastRuns: Record<string, unknown> = {};
    for (const sport of sports) {
      const run = await prisma.ingestionRun.findFirst({
        where: { sport },
        orderBy: { startedAt: 'desc' },
      });
      lastRuns[sport] = run
        ? { source: run.source, ok: run.ok, rows: run.rowsWritten, at: run.startedAt, note: run.note }
        : null;
    }

    // Feature row counts per sport (Phase 2).
    const featureCounts: Record<string, number> = {};
    for (const sport of sports) {
      featureCounts[sport] = await prisma.predictionFeature.count({ where: { sport } });
    }

    // Latest trained model + validation metrics per sport (Phase 3).
    const models: Record<string, unknown> = {};
    for (const sport of sports) {
      const m = await prisma.modelArtifact.findFirst({ where: { sport, ok: true }, orderBy: { trainedAt: 'desc' } });
      models[sport] = m
        ? { modelType: m.modelType, version: m.modelVersion, trainRows: m.trainRows, valRows: m.valRows, valAccuracy: m.valAccuracy, valBrier: m.valBrier, trainedAt: m.trainedAt }
        : (sport === 'rugby' ? { skipped: true, reason: 'insufficient_data' } : null);
    }
    const predictionCount = await prisma.enginePrediction.count();

    res.json({
      phase: 3,
      featureCounts,
      models,
      predictionCount,
      rowCounts: {
        football: { fixtures: footballFixtures, lineups: footballLineups },
        tennis: { matches: tennisMatches },
        nba: { gameLogs: nbaGameLogs },
        nfl: { teamGames: nflTeamGames, injuries: nflInjuries },
        mlb: { teamGames: mlbTeamGames, pitcherStats: mlbPitcherStats },
        rugby: { matches: rugbyMatches, standings: rugbyStandings },
      },
      lastRuns,
      budgets: {
        api_football: { remainingToday: await remainingProviderBudget('api_football') },
      },
      knownGaps: [
        'API-Football Free plan: seasons 2022–2024 only (no current season); lineups/injuries enriched incrementally at 100 req/day.',
        'MLB: starting-pitcher FIP/xFIP and team OPS/wRC+ unavailable (FanGraphs/BBRef return HTTP 403). ERA, results, ballpark, starting pitcher available via MLB StatsAPI.',
        'Rugby: ESPN data is sparse; few scheduled events surface per call though standings are populated.',
      ],
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Unified prediction output objects. Filter by ?sport= and ?upcoming=true.
predictionRouter.get('/prediction/predictions', async (req, res) => {
  try {
    const sport = typeof req.query['sport'] === 'string' ? req.query['sport'] : undefined;
    const upcoming = req.query['upcoming'] === 'true';
    const limit = Math.min(Number(req.query['limit']) || 100, 1000);

    const rows = await prisma.enginePrediction.findMany({
      where: {
        ...(sport ? { sport } : {}),
        ...(upcoming ? { kickoffUtc: { gte: new Date() } } : {}),
      },
      orderBy: { kickoffUtc: upcoming ? 'asc' : 'desc' },
      take: limit,
    });

    res.json({
      count: rows.length,
      predictions: rows.map((p) => ({
        sport: p.sport,
        league: p.league,
        matchId: p.matchKey,
        kickoff: p.kickoffUtc,
        homeTeam: p.homeTeam,
        awayTeam: p.awayTeam,
        predictedOutcome: p.predictedOutcome,
        probabilities: p.flag === 'insufficient_data' || p.predictedOutcome == null
          ? null
          : { home: p.pHome, draw: p.pDraw, away: p.pAway },
        expectedMargin: p.expectedMargin,
        confidenceTier: p.confidenceTier,
        ...(p.flag ? { flag: p.flag } : {}),
        featuresUsed: p.featuresUsed,
        modelVersion: p.modelVersion,
        generatedAt: p.generatedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
