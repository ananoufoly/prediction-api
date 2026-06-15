import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { mean, daysBetween, lastN, persistFeatures, type FeatureRow } from './shared.js';

/**
 * NBA feature engineering from nba_game_logs (+ nba_injuries).
 *
 * Each game has two team rows (home + away). We pair them by gameId, take the
 * home team's perspective, and compute rolling team strength AS-OF the game:
 * rolling offensive/defensive/net rating and pace over the prior 10 games, plus
 * days rest, back-to-back flag, and a count of "Out" players per team on the
 * game date (star-injury proxy).
 */

interface Log {
  gameId: string;
  gameDate: Date;
  teamAbbrev: string;
  isHome: boolean;
  won: boolean | null;
  pts: number | null;
  offRating: number | null;
  defRating: number | null;
  netRating: number | null;
  pace: number | null;
}

function rolling(prior: Log[], n: number) {
  const w = lastN(prior, n);
  return {
    off: mean(w.filter((g) => g.offRating != null).map((g) => g.offRating!)),
    def: mean(w.filter((g) => g.defRating != null).map((g) => g.defRating!)),
    net: mean(w.filter((g) => g.netRating != null).map((g) => g.netRating!)),
    pace: mean(w.filter((g) => g.pace != null).map((g) => g.pace!)),
  };
}

export async function computeBasketballFeatures(opts?: { since?: Date }): Promise<void> {
  await withRunLog('nba', 'features', async ({ addRows, note }) => {
    const logs = (await prisma.nbaGameLog.findMany({
      orderBy: { gameDate: 'asc' },
      select: {
        gameId: true, gameDate: true, teamAbbrev: true, isHome: true,
        won: true, pts: true, offRating: true, defRating: true, netRating: true, pace: true,
      },
    })) as Log[];
    if (logs.length === 0) { note('no nba game logs'); return; }

    // Per-team chronological history.
    const hist = new Map<string, Log[]>();
    for (const g of logs) {
      if (!hist.has(g.teamAbbrev)) hist.set(g.teamAbbrev, []);
      hist.get(g.teamAbbrev)!.push(g);
    }

    // Pair the two rows per game.
    const byGame = new Map<string, Log[]>();
    for (const g of logs) {
      if (!byGame.has(g.gameId)) byGame.set(g.gameId, []);
      byGame.get(g.gameId)!.push(g);
    }

    // Injuries: count of "Out" players per (team, date).
    const injuries = await prisma.nbaInjury.findMany({
      where: { status: 'Out' },
      select: { teamAbbrev: true, reportDate: true },
    });
    const injKey = (team: string, d: Date) => `${team}|${d.toISOString().slice(0, 10)}`;
    const injCount = new Map<string, number>();
    for (const i of injuries) injCount.set(injKey(i.teamAbbrev, i.reportDate), (injCount.get(injKey(i.teamAbbrev, i.reportDate)) ?? 0) + 1);

    const beforeIdx = (arr: Log[], date: Date, gameId: string) => {
      // prior = games strictly before this date (same-day games excluded to avoid leak)
      let i = arr.length;
      while (i > 0 && (arr[i - 1]!.gameDate >= date)) i--;
      return i;
    };

    const rows: FeatureRow[] = [];
    for (const [gameId, pair] of byGame) {
      if (pair.length !== 2) continue;
      const home = pair.find((p) => p.isHome);
      const away = pair.find((p) => !p.isHome);
      if (!home || !away) continue;
      if (opts?.since && home.gameDate < opts.since) continue;

      const homeHist = hist.get(home.teamAbbrev) ?? [];
      const awayHist = hist.get(away.teamAbbrev) ?? [];
      const homePrior = homeHist.slice(0, beforeIdx(homeHist, home.gameDate, gameId));
      const awayPrior = awayHist.slice(0, beforeIdx(awayHist, away.gameDate, gameId));

      const hr = rolling(homePrior, 10);
      const ar = rolling(awayPrior, 10);

      const homeRest = homePrior.length ? daysBetween(home.gameDate, homePrior[homePrior.length - 1]!.gameDate) : null;
      const awayRest = awayPrior.length ? daysBetween(away.gameDate, awayPrior[awayPrior.length - 1]!.gameDate) : null;

      rows.push({
        matchKey: `${gameId}`,
        league: 'NBA',
        kickoffUtc: home.gameDate,
        homeTeam: home.teamAbbrev,
        awayTeam: away.teamAbbrev,
        features: {
          target_home_win: home.won == null ? null : home.won ? 1 : 0,
          // Expected-margin regression target: home points − away points.
          point_margin: home.pts != null && away.pts != null ? home.pts - away.pts : null,
          home_off_rating_l10: hr.off, home_def_rating_l10: hr.def,
          home_net_rating_l10: hr.net, home_pace_l10: hr.pace,
          away_off_rating_l10: ar.off, away_def_rating_l10: ar.def,
          away_net_rating_l10: ar.net, away_pace_l10: ar.pace,
          net_rating_diff: hr.net != null && ar.net != null ? hr.net - ar.net : null,
          home_rest_days: homeRest, away_rest_days: awayRest,
          home_back_to_back: homeRest === 1 ? 1 : 0,
          away_back_to_back: awayRest === 1 ? 1 : 0,
          home_players_out: injCount.get(injKey(home.teamAbbrev, home.gameDate)) ?? 0,
          away_players_out: injCount.get(injKey(away.teamAbbrev, away.gameDate)) ?? 0,
          home_court: 1,
        },
      });
    }

    const n = await persistFeatures('nba', rows);
    addRows(n);
    note(`${n} games featurized`);
  });
}
