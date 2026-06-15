import { prisma } from '../../db.js';
import { normalizeTeam } from '../../ingestion/teamNorm.js';
import { getLeagueStandings } from '../../ingestion/standings.js';
import { withRunLog } from '../util/runLog.js';
import { mean, daysBetween, lastN, persistFeatures, type FeatureRow } from './shared.js';

/**
 * Football feature engineering.
 *
 * Spine: football_fixtures (OpenFootball history + API-Football). Results-based
 * features come from FINAL fixtures; rolling windows are computed AS-OF kickoff
 * (only matches strictly before the target match) so rows are leak-free.
 *
 * Inputs:
 *   - goals scored/conceded → football_fixtures (home/away split, last 5 & 10)
 *   - xG → Match table (Understat lives there); joined by normalized team+date.
 *          Currently sparse/empty until Understat backfills — degrades to null.
 *   - H2H → last 5 meetings between the two teams (any venue)
 *   - rest days → days since each team's previous fixture
 *   - injury/suspension count → football_lineups (INJURED/SUSPENDED roles)
 *   - league position delta → LeagueStanding (home rank − away rank)
 */

interface Fixture {
  id: string;
  league: string;
  season: number;
  kickoffUtc: Date;
  homeTeam: string;
  awayTeam: string;
  status: string;
  homeGoals: number | null;
  awayGoals: number | null;
}

// A team's historical match record used for rolling windows.
interface TeamMatch {
  date: Date;
  isHome: boolean;
  gf: number;
  ga: number;
  xgFor: number | null;
  xgAgainst: number | null;
  opponent: string; // normalized
}

function rollingGoals(matches: TeamMatch[], n: number, venue?: 'home' | 'away') {
  const filtered = venue
    ? matches.filter((m) => (venue === 'home' ? m.isHome : !m.isHome))
    : matches;
  const window = lastN(filtered, n);
  return {
    gf: mean(window.map((m) => m.gf)),
    ga: mean(window.map((m) => m.ga)),
    xgFor: mean(window.filter((m) => m.xgFor != null).map((m) => m.xgFor!)),
    xgAgainst: mean(window.filter((m) => m.xgAgainst != null).map((m) => m.xgAgainst!)),
  };
}

export async function computeFootballFeatures(opts?: {
  leagues?: string[];
  since?: Date;
}): Promise<void> {
  await withRunLog('football', 'features', async ({ addRows, note }) => {
    // Load all FINAL fixtures (results) to build per-team histories. Prefer
    // openfootball as the spine (broad history); API-Football overlaps on
    // 2022–2024 but openfootball covers more seasons.
    const where: Record<string, unknown> = { status: 'FINAL' };
    if (opts?.leagues) where['league'] = { in: opts.leagues };

    const fixtures = (await prisma.footballFixture.findMany({
      where,
      orderBy: { kickoffUtc: 'asc' },
      select: {
        id: true, league: true, season: true, kickoffUtc: true,
        homeTeam: true, awayTeam: true, status: true, homeGoals: true, awayGoals: true,
      },
    })) as Fixture[];

    if (fixtures.length === 0) { note('no FINAL fixtures'); return; }

    // Upcoming SCHEDULED fixtures are featurized too (so models can predict
    // them), but they never enter team history — only FINAL results do. Their
    // rolling features are computed AS-OF kickoff from prior FINAL matches.
    const upcomingWhere: Record<string, unknown> = { status: 'SCHEDULED' };
    if (opts?.leagues) upcomingWhere['league'] = { in: opts.leagues };
    const upcoming = (await prisma.footballFixture.findMany({
      where: upcomingWhere,
      orderBy: { kickoffUtc: 'asc' },
      select: {
        id: true, league: true, season: true, kickoffUtc: true,
        homeTeam: true, awayTeam: true, status: true, homeGoals: true, awayGoals: true,
      },
    })) as Fixture[];

    // --- xG lookup from the Match (Understat) table, keyed by normalized name+date ---
    const matchXg = await prisma.match.findMany({
      where: { homeXg: { not: null } },
      select: { homeTeam: true, awayTeam: true, kickoffUtc: true, homeXg: true, awayXg: true },
    });
    const xgKey = (home: string, away: string, d: Date) =>
      `${normalizeTeam(home)}|${normalizeTeam(away)}|${d.toISOString().slice(0, 10)}`;
    const xgMap = new Map<string, { homeXg: number; awayXg: number }>();
    for (const m of matchXg) {
      if (m.homeXg == null || m.awayXg == null) continue;
      xgMap.set(xgKey(m.homeTeam, m.awayTeam, m.kickoffUtc), { homeXg: m.homeXg, awayXg: m.awayXg });
    }

    // --- Build per-team chronological history (dedup by normalized teams+date) ---
    const histories = new Map<string, TeamMatch[]>(); // normTeam -> matches asc
    const h2h = new Map<string, Array<{ date: Date; homeNorm: string; hg: number; ag: number }>>();
    const seen = new Set<string>();

    const push = (team: string, m: TeamMatch) => {
      const k = normalizeTeam(team);
      if (!histories.has(k)) histories.set(k, []);
      histories.get(k)!.push(m);
    };
    const h2hKey = (a: string, b: string) => [normalizeTeam(a), normalizeTeam(b)].sort().join('::');

    for (const fx of fixtures) {
      if (fx.homeGoals == null || fx.awayGoals == null) continue;
      const dedup = `${normalizeTeam(fx.homeTeam)}|${normalizeTeam(fx.awayTeam)}|${fx.kickoffUtc.toISOString().slice(0, 10)}`;
      if (seen.has(dedup)) continue; // avoid double-counting api_football + openfootball overlap
      seen.add(dedup);

      const xg = xgMap.get(xgKey(fx.homeTeam, fx.awayTeam, fx.kickoffUtc)) ?? null;
      push(fx.homeTeam, {
        date: fx.kickoffUtc, isHome: true, gf: fx.homeGoals, ga: fx.awayGoals,
        xgFor: xg?.homeXg ?? null, xgAgainst: xg?.awayXg ?? null, opponent: normalizeTeam(fx.awayTeam),
      });
      push(fx.awayTeam, {
        date: fx.kickoffUtc, isHome: false, gf: fx.awayGoals, ga: fx.homeGoals,
        xgFor: xg?.awayXg ?? null, xgAgainst: xg?.homeXg ?? null, opponent: normalizeTeam(fx.homeTeam),
      });
      const hk = h2hKey(fx.homeTeam, fx.awayTeam);
      if (!h2h.has(hk)) h2h.set(hk, []);
      h2h.get(hk)!.push({ date: fx.kickoffUtc, homeNorm: normalizeTeam(fx.homeTeam), hg: fx.homeGoals, ag: fx.awayGoals });
    }

    // --- Standings (current) per league for position delta ---
    const standingsByLeague = new Map<string, Awaited<ReturnType<typeof getLeagueStandings>>>();
    for (const lg of new Set(fixtures.map((f) => f.league))) {
      try { standingsByLeague.set(lg, await getLeagueStandings(lg)); } catch { /* none */ }
    }

    // --- Injuries/suspensions per fixture (from football_lineups) ---
    // Map api_football fixture id → counts per team.
    const finalTargets = opts?.since
      ? fixtures.filter((f) => f.kickoffUtc >= opts.since!)
      : fixtures;
    // Featurize FINAL fixtures (training/backtest) + all upcoming SCHEDULED ones.
    const targetFixtures = [...finalTargets, ...upcoming];

    // Helper: as-of index into a sorted-asc array of matches (strictly before date).
    const beforeIdx = (arr: { date: Date }[], date: Date) => {
      let i = arr.length;
      while (i > 0 && arr[i - 1]!.date >= date) i--;
      return i;
    };

    const rows: FeatureRow[] = [];
    for (const fx of targetFixtures) {
      const homeN = normalizeTeam(fx.homeTeam);
      const awayN = normalizeTeam(fx.awayTeam);
      const homeHist = histories.get(homeN) ?? [];
      const awayHist = histories.get(awayN) ?? [];

      const homePrior = homeHist.slice(0, beforeIdx(homeHist, fx.kickoffUtc));
      const awayPrior = awayHist.slice(0, beforeIdx(awayHist, fx.kickoffUtc));

      const h5 = rollingGoals(homePrior, 5);
      const h10 = rollingGoals(homePrior, 10);
      const hHome = rollingGoals(homePrior, 5, 'home');
      const a5 = rollingGoals(awayPrior, 5);
      const a10 = rollingGoals(awayPrior, 10);
      const aAway = rollingGoals(awayPrior, 5, 'away');

      // Rest days
      const homeRest = homePrior.length ? daysBetween(fx.kickoffUtc, homePrior[homePrior.length - 1]!.date) : null;
      const awayRest = awayPrior.length ? daysBetween(fx.kickoffUtc, awayPrior[awayPrior.length - 1]!.date) : null;

      // H2H last 5 (prior meetings), from home team's perspective: points & goal diff
      const hk = h2hKey(fx.homeTeam, fx.awayTeam);
      const meetings = (h2h.get(hk) ?? []).filter((m) => m.date < fx.kickoffUtc);
      const last5 = lastN(meetings, 5);
      let h2hHomeWins = 0, h2hGdSum = 0;
      for (const m of last5) {
        // Orient to current home team.
        const curHomeWasHome = m.homeNorm === homeN;
        const gfCur = curHomeWasHome ? m.hg : m.ag;
        const gaCur = curHomeWasHome ? m.ag : m.hg;
        if (gfCur > gaCur) h2hHomeWins++;
        h2hGdSum += gfCur - gaCur;
      }

      // League position delta (home rank − away rank); lower rank = better.
      const standings = standingsByLeague.get(fx.league);
      const homeRank = standings?.get(homeN)?.rank ?? null;
      const awayRank = standings?.get(awayN)?.rank ?? null;
      const posDelta = homeRank != null && awayRank != null ? homeRank - awayRank : null;

      // Injury/suspension counts (only available for api_football-sourced fixtures).
      const [homeInj, awayInj] = await Promise.all([
        prisma.footballLineup.count({ where: { fixtureId: fx.id, team: fx.homeTeam, role: { in: ['INJURED', 'SUSPENDED'] } } }),
        prisma.footballLineup.count({ where: { fixtureId: fx.id, team: fx.awayTeam, role: { in: ['INJURED', 'SUSPENDED'] } } }),
      ]);

      rows.push({
        matchKey: fx.id,
        league: fx.league,
        kickoffUtc: fx.kickoffUtc,
        homeTeam: homeN,
        awayTeam: awayN,
        features: {
          home_gf_last5: h5.gf, home_ga_last5: h5.ga,
          home_gf_last10: h10.gf, home_ga_last10: h10.ga,
          home_gf_home_last5: hHome.gf, home_ga_home_last5: hHome.ga,
          away_gf_last5: a5.gf, away_ga_last5: a5.ga,
          away_gf_last10: a10.gf, away_ga_last10: a10.ga,
          away_gf_away_last5: aAway.gf, away_ga_away_last5: aAway.ga,
          home_xg_for_last5: h5.xgFor, home_xg_against_last5: h5.xgAgainst,
          away_xg_for_last5: a5.xgFor, away_xg_against_last5: a5.xgAgainst,
          h2h_matches: last5.length,
          h2h_home_wins: h2hHomeWins,
          h2h_goal_diff_avg: last5.length ? h2hGdSum / last5.length : null,
          home_rest_days: homeRest,
          away_rest_days: awayRest,
          home_injuries: homeInj,
          away_injuries: awayInj,
          home_rank: homeRank,
          away_rank: awayRank,
          position_delta: posDelta,
          // Fit targets for Dixon-Coles (actual scoreline of THIS match) and the
          // 1X2 outcome. Sourced from the same FINAL fixture that produced the
          // features above — no raw re-fetch. null for not-yet-played fixtures.
          actual_home_goals: fx.homeGoals,
          actual_away_goals: fx.awayGoals,
          target_outcome: fx.homeGoals != null && fx.awayGoals != null
            ? (fx.homeGoals > fx.awayGoals ? 0 : fx.homeGoals === fx.awayGoals ? 1 : 2) // 0=home,1=draw,2=away
            : null,
        },
      });
    }

    const n = await persistFeatures('football', rows);
    addRows(n);
    note(`${n} fixtures featurized; xG join had ${xgMap.size} matches available`);
  });
}
