import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';

/**
 * Rugby via ESPN's undocumented API (same pattern as src/ingestion/espnScores.ts).
 *
 * Rugby data is SPARSE — many competitions only expose a short window of events
 * per scoreboard call. We sweep a date range and flag gaps in the run note.
 * League ids confirmed live 2026-06-15.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/rugby';

const COMPETITIONS: Array<{ id: string; name: string }> = [
  { id: '270559', name: 'Top 14' },
  { id: '267979', name: 'Premiership' },
  { id: '270557', name: 'URC' },
  { id: '180659', name: 'Six Nations' },
  { id: '244293', name: 'Rugby Championship' },
];

interface EspnEvent {
  id: string;
  date: string;
  status: { type: { state: string; completed: boolean } };
  competitions: Array<{
    competitors: Array<{
      homeAway: 'home' | 'away';
      team: { displayName: string };
      score?: string;
    }>;
  }>;
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function mapStatus(state: string, completed: boolean): string {
  if (completed) return 'FINAL';
  return 'SCHEDULED';
}

async function fetchCompetition(
  id: string,
  name: string,
  addRows: (n: number) => void,
  note: (s: string) => void,
): Promise<void> {
  // Sweep current month ± a window: rugby scoreboards return few events per call.
  // Probe at weekly offsets from -28 to +28 days plus a no-date "current" call.
  const dates: string[] = [''];
  for (let off = -28; off <= 28; off += 7) {
    dates.push(yyyymmdd(new Date(Date.now() + off * 86_400_000)));
  }

  const seen = new Set<string>();
  let found = 0;
  for (const date of dates) {
    const url = date ? `${BASE}/${id}/scoreboard?dates=${date}` : `${BASE}/${id}/scoreboard`;
    let data: { events?: EspnEvent[] };
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      data = (await res.json()) as { events?: EspnEvent[] };
    } catch {
      continue;
    }

    for (const event of data.events ?? []) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const comp = event.competitions[0];
      if (!comp) continue;
      const home = comp.competitors.find((c) => c.homeAway === 'home');
      const away = comp.competitors.find((c) => c.homeAway === 'away');
      if (!home || !away) continue;

      const status = mapStatus(event.status.type.state, event.status.type.completed);
      const final = status === 'FINAL';
      const homeScore = final ? parseInt(home.score ?? '', 10) : NaN;
      const awayScore = final ? parseInt(away.score ?? '', 10) : NaN;

      await prisma.rugbyMatch.upsert({
        where: { espnEventId: event.id },
        create: {
          competition: name,
          espnEventId: event.id,
          kickoffUtc: new Date(event.date),
          homeTeam: home.team.displayName,
          awayTeam: away.team.displayName,
          status,
          homeScore: isNaN(homeScore) ? null : homeScore,
          awayScore: isNaN(awayScore) ? null : awayScore,
        },
        update: {
          status,
          ...(isNaN(homeScore) ? {} : { homeScore, awayScore }),
        },
      });
      addRows(1);
      found++;
    }
    // Be polite to ESPN.
    await new Promise((r) => setTimeout(r, 300));
  }
  if (found === 0) note(`${name}: no events in window (sparse/off-season)`);
  else note(`${name}: ${found} events`);
}

const STANDINGS_BASE = 'https://site.api.espn.com/apis/v2/sports/rugby';

async function fetchStandings(
  id: string,
  name: string,
  addRows: (n: number) => void,
  note: (s: string) => void,
): Promise<void> {
  try {
    const res = await fetch(`${STANDINGS_BASE}/${id}/standings`);
    if (!res.ok) { note(`${name} standings: HTTP ${res.status}`); return; }
    const data = (await res.json()) as {
      children?: Array<{ standings?: { entries?: Array<{
        team: { displayName: string };
        stats: Array<{ name: string; value?: number }>;
      }> } }>;
    };
    const entries = data.children?.[0]?.standings?.entries ?? [];
    if (entries.length === 0) { note(`${name} standings: none`); return; }

    const season = new Date().getUTCFullYear();
    for (const e of entries) {
      const stat = new Map(e.stats.map((s) => [s.name, s.value ?? 0]));
      await prisma.rugbyStanding.upsert({
        where: { competition_season_team: { competition: name, season, team: e.team.displayName } },
        create: {
          competition: name,
          season,
          team: e.team.displayName,
          rank: Math.round(stat.get('rank') ?? 0) || null,
          points: Math.round(stat.get('points') ?? 0) || null,
          played: Math.round(stat.get('gamesPlayed') ?? 0) || null,
        },
        update: {
          rank: Math.round(stat.get('rank') ?? 0) || null,
          points: Math.round(stat.get('points') ?? 0) || null,
          played: Math.round(stat.get('gamesPlayed') ?? 0) || null,
        },
      });
      addRows(1);
    }
    note(`${name} standings: ${entries.length} teams`);
  } catch (err) {
    note(`${name} standings failed: ${(err as Error).message}`);
  }
}

export async function ingestRugby(): Promise<void> {
  await withRunLog('rugby', 'espn', async ({ addRows, note }) => {
    for (const { id, name } of COMPETITIONS) {
      try {
        await fetchCompetition(id, name, addRows, note);
        await fetchStandings(id, name, addRows, note);
      } catch (err) {
        note(`${name} failed: ${(err as Error).message}`);
      }
    }
  });
}
