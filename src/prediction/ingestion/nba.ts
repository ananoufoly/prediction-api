import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { runPython } from '../util/pyBridge.js';

/**
 * NBA ingestion. Spawns fetch_nba.py (nba_api), upserts game logs via Prisma.
 * Target: current season + last 3 seasons.
 */

interface NbaRow {
  season: string;
  gameId: string;
  gameDate: string;
  teamId: number;
  teamAbbrev: string | null;
  opponentAbbrev: string | null;
  isHome: boolean;
  won: boolean | null;
  pts: number | null;
  offRating: number | null;
  defRating: number | null;
  netRating: number | null;
  pace: number | null;
}

/** Default: current season + previous 3 (NBA season label "YYYY-YY"). */
function defaultSeasons(): string[] {
  const now = new Date();
  // NBA season starting year: Oct–Dec → current year, Jan–Sep → previous year.
  const startYear = now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const labels: string[] = [];
  for (let i = 0; i < 4; i++) {
    const y = startYear - i;
    labels.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  }
  return labels;
}

export async function ingestNba(opts?: { seasons?: string[]; timeoutMs?: number }): Promise<void> {
  const seasons = opts?.seasons ?? defaultSeasons();

  await withRunLog('nba', 'nba_api', async ({ addRows, note }) => {
    const { rows, stderr } = await runPython('fetch_nba.py', seasons, {
      timeoutMs: opts?.timeoutMs ?? 8 * 60_000,
    });
    const lastDiag = stderr.trim().split('\n').slice(-3).join(' | ');
    if (lastDiag) note(lastDiag);

    for (const raw of rows as NbaRow[]) {
      const oppPts = null; // opponent points not in single-team log; left for feature stage join
      await prisma.nbaGameLog.upsert({
        where: { gameId_teamId: { gameId: raw.gameId, teamId: raw.teamId } },
        create: {
          season: raw.season,
          gameId: raw.gameId,
          gameDate: new Date(raw.gameDate),
          teamId: raw.teamId,
          teamAbbrev: raw.teamAbbrev ?? '',
          opponentAbbrev: raw.opponentAbbrev,
          isHome: raw.isHome,
          won: raw.won,
          pts: raw.pts,
          oppPts,
          offRating: raw.offRating,
          defRating: raw.defRating,
          netRating: raw.netRating,
          pace: raw.pace,
        },
        update: {
          won: raw.won,
          pts: raw.pts,
          offRating: raw.offRating,
          defRating: raw.defRating,
          netRating: raw.netRating,
          pace: raw.pace,
        },
      });
      addRows(1);
    }
  });
}
