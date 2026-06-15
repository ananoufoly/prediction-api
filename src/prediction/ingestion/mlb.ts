import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { runPython } from '../util/pyBridge.js';

/**
 * MLB ingestion. Spawns fetch_mlb.py which uses MLB's free StatsAPI
 * (pybaseball's FanGraphs/BBRef backends are HTTP-403 blocked from this network).
 * Target: 2020 season onward.
 *
 * KNOWN GAP: starting-pitcher FIP/xFIP and team OPS/wRC+ are unavailable
 * (FanGraphs blocked). Only ERA, results, ballpark, and starting pitcher are
 * ingested. This is flagged on every run via the ingestion-run note.
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

interface PitcherStatRow {
  kind: 'pitcher_stat';
  season: number;
  asOfDate: string;
  pitcherName: string;
  pitcherId: number | null;
  team: string | null;
  era: number | null;
  fip: number | null;
  xfip: number | null;
  ip: number | null;
}

function defaultSeasons(): number[] {
  const now = new Date();
  const latest = now.getUTCFullYear();
  const seasons: number[] = [];
  for (let y = 2020; y <= latest; y++) seasons.push(y);
  return seasons;
}

export async function ingestMlb(opts?: { seasons?: number[]; timeoutMs?: number }): Promise<void> {
  const seasons = opts?.seasons ?? defaultSeasons();

  await withRunLog('mlb', 'mlb_statsapi', async ({ addRows, note }) => {
    const { rows, stderr } = await runPython('fetch_mlb.py', seasons.map(String), {
      timeoutMs: opts?.timeoutMs ?? 15 * 60_000,
    });
    note('FIP/xFIP/wRC+/OPS unavailable (FanGraphs 403) — ERA/results/ballpark only');
    const lastDiag = stderr.trim().split('\n').slice(-2).join(' | ');
    if (lastDiag) note(lastDiag);

    for (const raw of rows as Array<TeamGameRow | PitcherStatRow>) {
      if (raw.kind === 'team_game') {
        await prisma.mlbTeamGame.upsert({
          where: { gameId_team: { gameId: raw.gameId, team: raw.team } },
          create: {
            season: raw.season,
            gameDate: new Date(raw.gameDate),
            gameId: raw.gameId,
            team: raw.team,
            opponent: raw.opponent,
            isHome: raw.isHome,
            won: raw.won,
            runsFor: raw.runsFor,
            runsAgainst: raw.runsAgainst,
            startingPitcher: raw.startingPitcher,
            ballpark: raw.ballpark,
          },
          update: {
            won: raw.won,
            runsFor: raw.runsFor,
            runsAgainst: raw.runsAgainst,
            startingPitcher: raw.startingPitcher,
          },
        });
        addRows(1);
      } else if (raw.kind === 'pitcher_stat') {
        await prisma.mlbPitcherStat.upsert({
          where: { asOfDate_pitcherName: { asOfDate: new Date(raw.asOfDate), pitcherName: raw.pitcherName } },
          create: {
            season: raw.season,
            asOfDate: new Date(raw.asOfDate),
            pitcherName: raw.pitcherName,
            pitcherId: raw.pitcherId,
            team: raw.team,
            era: raw.era,
            fip: raw.fip,
            xfip: raw.xfip,
            ip: raw.ip,
          },
          update: { era: raw.era, team: raw.team },
        });
        addRows(1);
      }
    }
  });
}
