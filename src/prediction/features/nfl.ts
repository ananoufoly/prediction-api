import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { mean, daysBetween, lastN, persistFeatures, type FeatureRow } from './shared.js';
import { NFL_STADIUMS } from './nflStadiums.js';

/**
 * NFL feature engineering from nfl_team_games (+ open-meteo weather).
 *
 * Features per game (home perspective): rolling offensive/defensive EPA/play
 * over prior 5 games, EPA differential, days rest, bye-week flag, home/away,
 * starting QB present flag, and game-day weather (temperature, wind) at the
 * home stadium via open-meteo (free, no key). Dome venues are flagged and
 * weather is zeroed for them.
 *
 * KNOWN GAP: DVOA is NOT computable from available data (it requires Football
 * Outsiders' proprietary opponent-adjusted baselines). Flagged on every run.
 */

interface Game {
  gameId: string;
  season: number;
  week: number;
  gameDate: Date | null;
  team: string;
  opponent: string;
  isHome: boolean;
  won: boolean | null;
  offEpaPerPlay: number | null;
  defEpaPerPlay: number | null;
  startingQb: string | null;
}

function rollingEpa(prior: Game[], n: number) {
  const w = lastN(prior, n);
  return {
    off: mean(w.filter((g) => g.offEpaPerPlay != null).map((g) => g.offEpaPerPlay!)),
    def: mean(w.filter((g) => g.defEpaPerPlay != null).map((g) => g.defEpaPerPlay!)),
  };
}

// Simple in-run weather cache keyed by lat,lon,date.
const weatherCache = new Map<string, { temp: number | null; wind: number | null }>();

async function fetchWeather(lat: number, lon: number, date: string): Promise<{ temp: number | null; wind: number | null }> {
  const key = `${lat},${lon},${date}`;
  const cached = weatherCache.get(key);
  if (cached) return cached;
  try {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}`
      + `&start_date=${date}&end_date=${date}&daily=temperature_2m_mean,wind_speed_10m_max&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) { weatherCache.set(key, { temp: null, wind: null }); return { temp: null, wind: null }; }
    const data = (await res.json()) as { daily?: { temperature_2m_mean?: (number | null)[]; wind_speed_10m_max?: (number | null)[] } };
    const result = {
      temp: data.daily?.temperature_2m_mean?.[0] ?? null,
      wind: data.daily?.wind_speed_10m_max?.[0] ?? null,
    };
    weatherCache.set(key, result);
    return result;
  } catch {
    weatherCache.set(key, { temp: null, wind: null });
    return { temp: null, wind: null };
  }
}

export async function computeNflFeatures(opts?: { since?: Date; fetchWeather?: boolean }): Promise<void> {
  const wantWeather = opts?.fetchWeather ?? true;
  await withRunLog('nfl', 'features', async ({ addRows, note }) => {
    note('DVOA not computable (requires proprietary baselines) — using EPA/play instead');

    const games = (await prisma.nflTeamGame.findMany({
      orderBy: [{ season: 'asc' }, { week: 'asc' }],
      select: {
        gameId: true, season: true, week: true, gameDate: true, team: true, opponent: true,
        isHome: true, won: true, offEpaPerPlay: true, defEpaPerPlay: true, startingQb: true,
      },
    })) as Game[];
    if (games.length === 0) { note('no nfl games'); return; }

    const hist = new Map<string, Game[]>();
    for (const g of games) {
      if (!hist.has(g.team)) hist.set(g.team, []);
      hist.get(g.team)!.push(g);
    }
    const byGame = new Map<string, Game[]>();
    for (const g of games) {
      if (!byGame.has(g.gameId)) byGame.set(g.gameId, []);
      byGame.get(g.gameId)!.push(g);
    }

    const idxOf = (arr: Game[], g: Game) => arr.findIndex((x) => x.gameId === g.gameId);

    const rows: FeatureRow[] = [];
    for (const [gameId, pair] of byGame) {
      if (pair.length !== 2) continue;
      const home = pair.find((p) => p.isHome);
      const away = pair.find((p) => !p.isHome);
      if (!home || !away || !home.gameDate) continue;
      if (opts?.since && home.gameDate < opts.since) continue;

      const homeHist = hist.get(home.team) ?? [];
      const awayHist = hist.get(away.team) ?? [];
      const hi = idxOf(homeHist, home);
      const ai = idxOf(awayHist, away);
      const homePrior = hi > 0 ? homeHist.slice(0, hi) : [];
      const awayPrior = ai > 0 ? awayHist.slice(0, ai) : [];

      const he = rollingEpa(homePrior, 5);
      const ae = rollingEpa(awayPrior, 5);

      // Rest + bye: gap in weeks vs prior game within same season.
      const prevHome = homePrior[homePrior.length - 1];
      const prevAway = awayPrior[awayPrior.length - 1];
      // Both teams play on home.gameDate (same game); use it as the current date.
      const homeRest = prevHome?.gameDate ? daysBetween(home.gameDate, prevHome.gameDate) : null;
      const awayRest = prevAway?.gameDate ? daysBetween(home.gameDate, prevAway.gameDate) : null;
      const homeBye = prevHome && prevHome.season === home.season ? (home.week - prevHome.week > 1 ? 1 : 0) : 0;
      const awayBye = prevAway && prevAway.season === away.season ? (away.week - prevAway.week > 1 ? 1 : 0) : 0;

      // Weather at home stadium.
      const stadium = NFL_STADIUMS[home.team];
      let temp: number | null = null, wind: number | null = null, dome = 0;
      if (stadium) {
        dome = stadium.dome ? 1 : 0;
        if (!stadium.dome && wantWeather) {
          const dateStr = home.gameDate.toISOString().slice(0, 10);
          const w = await fetchWeather(stadium.lat, stadium.lon, dateStr);
          temp = w.temp; wind = w.wind;
        } else if (stadium.dome) {
          temp = 21; wind = 0; // controlled environment
        }
      }

      rows.push({
        matchKey: `${gameId}`,
        league: 'NFL',
        kickoffUtc: home.gameDate,
        homeTeam: home.team,
        awayTeam: away.team,
        features: {
          target_home_win: home.won == null ? null : home.won ? 1 : 0,
          home_off_epa_l5: he.off, home_def_epa_l5: he.def,
          away_off_epa_l5: ae.off, away_def_epa_l5: ae.def,
          epa_diff: he.off != null && ae.off != null && he.def != null && ae.def != null
            ? (he.off - he.def) - (ae.off - ae.def) : null,
          home_rest_days: homeRest, away_rest_days: awayRest,
          home_bye_week: homeBye, away_bye_week: awayBye,
          home_qb_present: home.startingQb ? 1 : 0,
          away_qb_present: away.startingQb ? 1 : 0,
          home_field: 1,
          stadium_dome: dome,
          weather_temp_c: temp,
          weather_wind_kmh: wind,
        },
      });
    }

    const n = await persistFeatures('nfl', rows);
    addRows(n);
    note(`${n} games featurized; weather lookups=${weatherCache.size}`);
  });
}
