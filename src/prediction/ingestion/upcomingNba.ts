import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';

/**
 * Upcoming NBA games from ESPN scoreboard (free). Written to nba_game_logs with
 * won=null. ESPN team abbreviations differ from our nba_api logs, so we map them.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

// ESPN abbreviation -> our nba_api abbreviation.
const ABBR: Record<string, string> = {
  SA: 'SAS', NY: 'NYK', GS: 'GSW', NO: 'NOP', UTAH: 'UTA', WSH: 'WAS', PHX: 'PHX', PHO: 'PHX',
};
const mapAbbr = (a: string) => ABBR[a] ?? a;

interface EspnEvent {
  id: string;
  date: string;
  season?: { year?: number };
  status: { type: { completed: boolean } };
  competitions: Array<{ competitors: Array<{ homeAway: 'home' | 'away'; team: { abbreviation: string } }> }>;
}

function yyyymmdd(d: Date): string { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

// NBA season label "YYYY-YY" from a kickoff date (season starts in October).
function seasonLabel(d: Date): string {
  const y = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export async function ingestUpcomingNba(opts?: { forwardDays?: number }): Promise<void> {
  const forwardDays = opts?.forwardDays ?? 14;
  await withRunLog('nba', 'nba_upcoming', async ({ addRows, note }) => {
    const seen = new Set<string>();
    let written = 0;
    for (let off = 0; off <= forwardDays; off++) {
      const date = yyyymmdd(new Date(Date.now() + off * 86_400_000));
      let data: { events?: EspnEvent[] };
      try {
        const res = await fetch(`${BASE}/scoreboard?dates=${date}`);
        if (!res.ok) continue;
        data = (await res.json()) as { events?: EspnEvent[] };
      } catch { continue; }

      for (const ev of data.events ?? []) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (ev.status.type.completed) continue;
        const comp = ev.competitions[0];
        const home = comp?.competitors.find((c) => c.homeAway === 'home');
        const away = comp?.competitors.find((c) => c.homeAway === 'away');
        if (!home || !away) continue;
        const kickoff = new Date(ev.date);
        if (isNaN(kickoff.getTime()) || kickoff.getTime() < Date.now() - 6 * 3_600_000) continue;

        // One row per team (home perspective + away), won=null.
        for (const [tm, opp, isHome] of [[home, away, true], [away, home, false]] as const) {
          await prisma.nbaGameLog.upsert({
            where: { gameId_teamId: { gameId: ev.id, teamId: hashTeam(mapAbbr(tm.team.abbreviation)) } },
            create: {
              season: seasonLabel(kickoff), gameId: ev.id, gameDate: kickoff,
              teamId: hashTeam(mapAbbr(tm.team.abbreviation)), teamAbbrev: mapAbbr(tm.team.abbreviation),
              opponentAbbrev: mapAbbr(opp.team.abbreviation), isHome, won: null,
            },
            update: { gameDate: kickoff, opponentAbbrev: mapAbbr(opp.team.abbreviation) },
          });
          addRows(1);
        }
        written++;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    note(`${written} upcoming games`);
  });
}

// nba_game_logs.teamId is an Int; ESPN gives no numeric id here, so derive a
// stable synthetic id from the abbreviation (kept distinct from real nba_api ids
// by offsetting into a high range).
function hashTeam(abbr: string): number {
  let h = 0;
  for (let i = 0; i < abbr.length; i++) h = (h * 31 + abbr.charCodeAt(i)) | 0;
  return 900000000 + (Math.abs(h) % 1000000);
}
