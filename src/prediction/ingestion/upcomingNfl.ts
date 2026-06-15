import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { runPython } from '../util/pyBridge.js';

/**
 * Upcoming NFL games via nfl_data_py schedule (won=null, no EPA yet). The model
 * scores them from each team's rolling EPA form computed as-of the game.
 */
interface Row {
  kind: 'team_game'; season: number; week: number; gameId: string; gameDate: string | null;
  team: string; opponent: string; isHome: boolean; won: boolean | null;
  pointsFor: number | null; pointsAgainst: number | null;
  offEpaPerPlay: number | null; defEpaPerPlay: number | null;
}

export async function ingestUpcomingNfl(opts?: { year?: number }): Promise<void> {
  const year = opts?.year ?? (new Date().getUTCMonth() >= 8 ? new Date().getUTCFullYear() : new Date().getUTCFullYear());
  await withRunLog('nfl', 'nfl_upcoming', async ({ addRows, note }) => {
    const { rows, stderr } = await runPython('fetch_nfl.py', ['--upcoming', String(year)], { timeoutMs: 3 * 60_000 });
    const diag = stderr.trim().split('\n').slice(-1)[0]; if (diag) note(diag);
    for (const raw of rows as Row[]) {
      if (raw.kind !== 'team_game') continue;
      await prisma.nflTeamGame.upsert({
        where: { gameId_team: { gameId: raw.gameId, team: raw.team } },
        create: {
          season: raw.season, week: raw.week, gameId: raw.gameId,
          gameDate: raw.gameDate ? new Date(raw.gameDate) : null, team: raw.team, opponent: raw.opponent,
          isHome: raw.isHome, won: null, offEpaPerPlay: null, defEpaPerPlay: null,
        },
        update: { gameDate: raw.gameDate ? new Date(raw.gameDate) : null },
      });
      addRows(1);
    }
  });
}
