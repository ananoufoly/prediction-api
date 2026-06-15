import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { runPython } from '../util/pyBridge.js';

/**
 * NFL ingestion (nfl_data_py). Spawns fetch_nfl.py which emits team-game rows
 * (with rolled-up offense/defense EPA per play) and weekly injury rows.
 * Target: 2020 season onward.
 */

interface TeamGameRow {
  kind: 'team_game';
  season: number;
  week: number;
  gameId: string;
  gameDate: string | null;
  team: string;
  opponent: string;
  isHome: boolean;
  won: boolean | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  offEpaPerPlay: number | null;
  defEpaPerPlay: number | null;
}

interface InjuryRow {
  kind: 'injury';
  season: number;
  week: number;
  team: string;
  playerName: string;
  position: string | null;
  status: string | null;
  reason: string | null;
}

function defaultYears(): number[] {
  const now = new Date();
  // NFL season year: Sep–Dec → current year, else previous.
  const latest = now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const years: number[] = [];
  for (let y = 2020; y <= latest; y++) years.push(y);
  return years;
}

export async function ingestNfl(opts?: { years?: number[]; timeoutMs?: number }): Promise<void> {
  const years = opts?.years ?? defaultYears();

  await withRunLog('nfl', 'nfl_data_py', async ({ addRows, note }) => {
    const { rows, stderr } = await runPython('fetch_nfl.py', years.map(String), {
      timeoutMs: opts?.timeoutMs ?? 12 * 60_000,
    });
    const lastDiag = stderr.trim().split('\n').slice(-3).join(' | ');
    if (lastDiag) note(lastDiag);

    for (const raw of rows as Array<TeamGameRow | InjuryRow>) {
      if (raw.kind === 'team_game') {
        await prisma.nflTeamGame.upsert({
          where: { gameId_team: { gameId: raw.gameId, team: raw.team } },
          create: {
            season: raw.season,
            week: raw.week,
            gameId: raw.gameId,
            gameDate: raw.gameDate ? new Date(raw.gameDate) : null,
            team: raw.team,
            opponent: raw.opponent,
            isHome: raw.isHome,
            won: raw.won,
            pointsFor: raw.pointsFor,
            pointsAgainst: raw.pointsAgainst,
            offEpaPerPlay: raw.offEpaPerPlay,
            defEpaPerPlay: raw.defEpaPerPlay,
          },
          update: {
            won: raw.won,
            pointsFor: raw.pointsFor,
            pointsAgainst: raw.pointsAgainst,
            offEpaPerPlay: raw.offEpaPerPlay,
            defEpaPerPlay: raw.defEpaPerPlay,
          },
        });
        addRows(1);
      } else if (raw.kind === 'injury') {
        await prisma.nflInjury.upsert({
          where: {
            season_week_team_playerName: {
              season: raw.season, week: raw.week, team: raw.team, playerName: raw.playerName,
            },
          },
          create: {
            season: raw.season,
            week: raw.week,
            team: raw.team,
            playerName: raw.playerName,
            position: raw.position,
            status: raw.status,
            reason: raw.reason,
          },
          update: { status: raw.status, reason: raw.reason, position: raw.position },
        });
        addRows(1);
      }
    }
  });
}
