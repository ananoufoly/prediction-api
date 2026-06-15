import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { runPython } from '../util/pyBridge.js';

/**
 * Upcoming MLB fixtures from MLB StatsAPI (forward date window). Same shape as
 * historical mlb_team_games, but won/runs are null (not yet played). The trained
 * model scores them from the home team's rolling form + starting-pitcher ERA.
 */

interface TeamGameRow {
  kind: 'team_game';
  season: number;
  gameDate: string;
  gameId: string;
  team: string;
  opponent: string;
  isHome: boolean;
  won: boolean | null;
  runsFor: number | null;
  runsAgainst: number | null;
  startingPitcher: string | null;
  ballpark: string | null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function ingestUpcomingMlb(opts?: { forwardDays?: number }): Promise<void> {
  const forwardDays = opts?.forwardDays ?? 14;
  await withRunLog('mlb', 'mlb_upcoming', async ({ addRows, note }) => {
    const start = ymd(new Date());
    const end = ymd(new Date(Date.now() + forwardDays * 86_400_000));
    const { rows, stderr } = await runPython('fetch_mlb.py', ['--upcoming', start, end], { timeoutMs: 4 * 60_000 });
    const diag = stderr.trim().split('\n').slice(-1)[0];
    if (diag) note(diag);

    for (const raw of rows as TeamGameRow[]) {
      if (raw.kind !== 'team_game') continue;
      await prisma.mlbTeamGame.upsert({
        where: { gameId_team: { gameId: raw.gameId, team: raw.team } },
        create: {
          season: raw.season, gameDate: new Date(raw.gameDate), gameId: raw.gameId,
          team: raw.team, opponent: raw.opponent, isHome: raw.isHome, won: raw.won,
          runsFor: raw.runsFor, runsAgainst: raw.runsAgainst,
          startingPitcher: raw.startingPitcher, ballpark: raw.ballpark,
        },
        update: {
          // Only overwrite forward-looking fields; never clobber a played result.
          startingPitcher: raw.startingPitcher,
          ...(raw.won != null ? { won: raw.won, runsFor: raw.runsFor, runsAgainst: raw.runsAgainst } : {}),
        },
      });
      addRows(1);
    }
  });
}
