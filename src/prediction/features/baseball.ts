import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { mean, daysBetween, lastN, persistFeatures, type FeatureRow } from './shared.js';

/**
 * MLB feature engineering from mlb_team_games (+ mlb_pitcher_stats).
 *
 * KNOWN GAPS (FanGraphs/BBRef HTTP-403): starting-pitcher FIP/xFIP, team OPS,
 * wRC+, and bullpen ERA are UNAVAILABLE. Spec features that depend on them are
 * emitted as null and the gaps are flagged on every run.
 *
 * BUILT from MLB StatsAPI data:
 *   - starting-pitcher ERA (season-to-date snapshot) for each side
 *   - rolling team runs scored / allowed (last 14 games) — OPS-form proxy
 *   - home/away
 *   - ballpark run factor — empirical: park's avg total runs ÷ league avg
 *   - days rest since previous game
 */

interface TG {
  gameId: string;
  season: number;
  gameDate: Date;
  team: string;
  opponent: string;
  isHome: boolean;
  won: boolean | null;
  runsFor: number | null;
  runsAgainst: number | null;
  startingPitcher: string | null;
  ballpark: string | null;
}

export async function computeBaseballFeatures(opts?: { since?: Date }): Promise<void> {
  await withRunLog('mlb', 'features', async ({ addRows, note }) => {
    note('FIP/xFIP, team OPS/wRC+, bullpen ERA UNAVAILABLE (FanGraphs 403) — emitted null');

    const games = (await prisma.mlbTeamGame.findMany({
      orderBy: { gameDate: 'asc' },
      select: {
        gameId: true, season: true, gameDate: true, team: true, opponent: true, isHome: true,
        won: true, runsFor: true, runsAgainst: true, startingPitcher: true, ballpark: true,
      },
    })) as TG[];
    if (games.length === 0) { note('no mlb games'); return; }

    // Pitcher ERA snapshot per (season, name) — use season-to-date row.
    const pstats = await prisma.mlbPitcherStat.findMany({ select: { season: true, pitcherName: true, era: true } });
    const eraMap = new Map<string, number | null>();
    for (const p of pstats) eraMap.set(`${p.season}|${p.pitcherName}`, p.era);

    // Ballpark run factor: park avg total runs / league avg total runs (per season).
    const parkRuns = new Map<string, { runs: number; games: number }>(); // "season|park"
    const leagueRuns = new Map<number, { runs: number; games: number }>();
    for (const g of games) {
      if (g.runsFor == null || g.runsAgainst == null) continue;
      const total = g.runsFor + g.runsAgainst;
      // Count each game once (home perspective) to avoid double counting.
      if (g.isHome && g.ballpark) {
        const pk = `${g.season}|${g.ballpark}`;
        const pr = parkRuns.get(pk) ?? { runs: 0, games: 0 };
        pr.runs += total; pr.games += 1; parkRuns.set(pk, pr);
        const lr = leagueRuns.get(g.season) ?? { runs: 0, games: 0 };
        lr.runs += total; lr.games += 1; leagueRuns.set(g.season, lr);
      }
    }
    const parkFactor = (season: number, park: string | null): number | null => {
      if (!park) return null;
      const pr = parkRuns.get(`${season}|${park}`);
      const lr = leagueRuns.get(season);
      if (!pr || !lr || pr.games < 10 || lr.games === 0) return null;
      const parkAvg = pr.runs / pr.games;
      const leagueAvg = lr.runs / lr.games;
      return leagueAvg ? parkAvg / leagueAvg : null;
    };

    // Per-team history for rolling form + rest.
    const hist = new Map<string, TG[]>();
    for (const g of games) {
      if (!hist.has(g.team)) hist.set(g.team, []);
      hist.get(g.team)!.push(g);
    }
    const byGame = new Map<string, TG[]>();
    for (const g of games) {
      if (!byGame.has(g.gameId)) byGame.set(g.gameId, []);
      byGame.get(g.gameId)!.push(g);
    }

    const idxOf = (arr: TG[], g: TG) => arr.findIndex((x) => x.gameId === g.gameId && x.team === g.team);

    const rollRuns = (prior: TG[], n: number) => {
      const w = lastN(prior, n);
      return {
        rf: mean(w.filter((x) => x.runsFor != null).map((x) => x.runsFor!)),
        ra: mean(w.filter((x) => x.runsAgainst != null).map((x) => x.runsAgainst!)),
      };
    };

    const rows: FeatureRow[] = [];
    for (const [gameId, pair] of byGame) {
      if (pair.length !== 2) continue;
      const home = pair.find((p) => p.isHome);
      const away = pair.find((p) => !p.isHome);
      if (!home || !away) continue;
      if (opts?.since && home.gameDate < opts.since) continue;

      const homeHist = hist.get(home.team) ?? [];
      const awayHist = hist.get(away.team) ?? [];
      const hi = idxOf(homeHist, home);
      const ai = idxOf(awayHist, away);
      const homePrior = hi > 0 ? homeHist.slice(0, hi) : [];
      const awayPrior = ai > 0 ? awayHist.slice(0, ai) : [];

      const hr = rollRuns(homePrior, 14);
      const ar = rollRuns(awayPrior, 14);
      const homeRest = homePrior.length ? daysBetween(home.gameDate, homePrior[homePrior.length - 1]!.gameDate) : null;
      const awayRest = awayPrior.length ? daysBetween(away.gameDate, awayPrior[awayPrior.length - 1]!.gameDate) : null;

      const homeSpEra = home.startingPitcher ? eraMap.get(`${home.season}|${home.startingPitcher}`) ?? null : null;
      const awaySpEra = away.startingPitcher ? eraMap.get(`${away.season}|${away.startingPitcher}`) ?? null : null;

      rows.push({
        matchKey: `${gameId}`,
        league: 'MLB',
        kickoffUtc: home.gameDate,
        homeTeam: home.team,
        awayTeam: away.team,
        features: {
          target_home_win: home.won == null ? null : home.won ? 1 : 0,
          // Expected run-line regression target: home runs − away runs.
          run_line: home.runsFor != null && home.runsAgainst != null ? home.runsFor - home.runsAgainst : null,
          home_sp_era: homeSpEra,
          away_sp_era: awaySpEra,
          sp_era_diff: homeSpEra != null && awaySpEra != null ? homeSpEra - awaySpEra : null,
          home_runs_for_l14: hr.rf, home_runs_against_l14: hr.ra,
          away_runs_for_l14: ar.rf, away_runs_against_l14: ar.ra,
          run_form_diff: hr.rf != null && ar.rf != null ? (hr.rf - hr.ra!) - (ar.rf - ar.ra!) : null,
          home_rest_days: homeRest, away_rest_days: awayRest,
          ballpark_run_factor: parkFactor(home.season, home.ballpark),
          home_field: 1,
          // Gaps (FanGraphs blocked) — present in schema for model compatibility:
          home_sp_fip: null, away_sp_fip: null,
          home_team_ops_l14: null, away_team_ops_l14: null,
          home_bullpen_era_l7: null, away_bullpen_era_l7: null,
        },
      });
    }

    const n = await persistFeatures('mlb', rows);
    addRows(n);
    note(`${n} games featurized; ${parkRuns.size} park-seasons for run factors`);
  });
}
