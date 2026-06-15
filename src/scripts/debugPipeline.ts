import { prisma } from '../db.js';
import { computeXgRatings } from '../model/xgRatings.js';
import { applyEloPriors } from '../model/elo.js';
import { computeMatchProbsDC, fitRho, type TrainingMatch } from '../model/dixonColes.js';
import { expectedGoals } from '../model/poisson.js';
import { fitCalibration } from '../model/calibration.js';
import { shinDevig } from '../math/shin.js';
import { computeEdge, applyModelCalibration, type MarketOdds } from '../selection/edge.js';
import { assignConfidence } from '../selection/confidence.js';
import { computeKelly } from '../selection/kelly.js';
import { prob, odds as brandOdds, edgePct } from '../types/branded.js';

async function debugLeague(league: string) {
  console.log(`\n${'═'.repeat(60)}\nDEBUG: ${league}\n${'═'.repeat(60)}`);

  const lr = await computeXgRatings(league);
  await applyEloPriors(league, lr.teams);

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
  const points = await prisma.calibrationPoint.findMany({
    where: { match: { league }, modelVersion: 'v1' },
    orderBy: { matchDate: 'asc' },
  });
  const marketMap = new Map<string, Array<{ predicted: number; actual: number }>>();
  for (const p of points) {
    if (!marketMap.has(p.market)) marketMap.set(p.market, []);
    marketMap.get(p.market)!.push({ predicted: p.predictedProb, actual: p.actualOutcome });
  }
  const calibrationModels = new Map();
  for (const [market, pairs] of marketMap) {
    calibrationModels.set(market, fitCalibration(league, market, pairs));
  }

  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);

  const upcomingMatches = await prisma.match.findMany({
    where: { league, status: 'SCHEDULED', kickoffUtc: { gte: now, lte: weekAhead } },
    include: {
      oddsSnapshots: {
        where: { isClosing: false, fetchedAt: { gte: new Date(now.getTime() - 6 * 3600_000) } },
        orderBy: { fetchedAt: 'desc' },
      },
    },
  });

  console.log(`Upcoming matches in window: ${upcomingMatches.length}`);
  console.log(`Matches with fresh odds: ${upcomingMatches.filter((m) => m.oddsSnapshots.length > 0).length}`);

  for (const match of upcomingMatches.slice(0, 3)) {
    const homeRating = lr.teams.get(match.homeTeam);
    const awayRating = lr.teams.get(match.awayTeam);

    console.log(`\n  ${match.homeTeam} vs ${match.awayTeam} | ${match.kickoffUtc.toISOString().slice(0,16)}`);
    console.log(`  Ratings: home=${homeRating ? `att=${homeRating.attack.toFixed(3)} def=${homeRating.defense.toFixed(3)}` : 'MISSING'}`);
    console.log(`  Ratings: away=${awayRating ? `att=${awayRating.attack.toFixed(3)} def=${awayRating.defense.toFixed(3)}` : 'MISSING'}`);
    console.log(`  Odds snapshots: ${match.oddsSnapshots.length}`);

    if (!homeRating || !awayRating) { console.log('  → SKIPPED: missing ratings'); continue; }
    if (match.oddsSnapshots.length === 0) { console.log('  → SKIPPED: no odds'); continue; }

    const probs = computeMatchProbsDC(
      homeRating.attack, homeRating.defense,
      awayRating.attack, awayRating.defense,
      lr.leagueAvgAttack, rho, undefined, lr.goalConversionFactor,
    );
    console.log(`  Model probs: home=${(probs.pHome*100).toFixed(1)}% draw=${(probs.pDraw*100).toFixed(1)}% away=${(probs.pAway*100).toFixed(1)}% over2.5=${(probs.pOver25*100).toFixed(1)}%`);

    // Show a few odds
    const bookmakers = [...new Set(match.oddsSnapshots.map((s) => s.bookmaker))];
    console.log(`  Bookmakers: ${bookmakers.join(', ')}`);

    // Sample one market (h2h)
    const h2hSnaps = match.oddsSnapshots.filter((s) => s.market === 'h2h');
    if (h2hSnaps.length > 0) {
      const allDecimal = h2hSnaps.map((s) => s.decimalOdds);
      try {
        const shin = shinDevig(allDecimal);
        console.log(`  Shin devig h2h: ${h2hSnaps.map((s, i) => `${s.outcome}=${(shin.probabilities[i]!*100).toFixed(1)}%(raw @${s.decimalOdds})`).join(' ')}`);

        const pinnacleH2h = h2hSnaps.filter((s) => s.bookmaker === 'pinnacle');
        console.log(`  Pinnacle h2h snaps: ${pinnacleH2h.length}`);

        for (const snap of h2hSnaps.slice(0, 3)) {
          const rawModelProb = snap.outcome === match.homeTeam ? probs.pHome
            : snap.outcome === 'Draw' ? probs.pDraw
            : snap.outcome === match.awayTeam ? probs.pAway
            : undefined;
          if (rawModelProb === undefined) { console.log(`    ${snap.outcome}: no model prob mapping`); continue; }

          const calModel = calibrationModels.get('h2h') ?? null;
          const calibratedProb = applyModelCalibration(rawModelProb, calModel);
          const idx = h2hSnaps.findIndex((s) => s.outcome === snap.outcome);
          const bookieFairProb = shin.probabilities[idx] ?? (1 / snap.decimalOdds);
          const edge = computeEdge(calibratedProb, prob(bookieFairProb));

          const pinnIdx = pinnacleH2h.findIndex((s) => s.outcome === snap.outcome);
          let pinnFair: number | null = null;
          if (pinnacleH2h.length >= 2 && pinnIdx !== -1) {
            try {
              const ps = shinDevig(pinnacleH2h.map((s) => s.decimalOdds));
              pinnFair = ps.probabilities[pinnIdx] ?? null;
            } catch { /* ignore */ }
          }

          const conf = assignConfidence(
            edgePct(edge),
            calibratedProb,
            pinnFair !== null ? prob(pinnFair) : null,
            calModel?.fitted ?? false,
          );
          const kelly = computeKelly(calibratedProb, snap.decimalOdds, 1000);

          console.log(`    ${snap.outcome.padEnd(25)} model=${(calibratedProb*100).toFixed(1)}% bookie=${(bookieFairProb*100).toFixed(1)}% edge=${(edge*100).toFixed(2)}% conf=${conf.confidence} kelly_stake=€${kelly.recommendedStake.toFixed(2)}`);
          console.log(`      reason: ${conf.reason}`);
        }
      } catch (e) {
        console.log(`  Shin failed: ${e}`);
      }
    }
  }
}

async function main() {
  for (const league of ['EPL', 'La Liga']) {
    await debugLeague(league);
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
