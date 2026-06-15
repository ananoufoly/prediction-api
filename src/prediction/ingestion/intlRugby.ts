import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { eloUpdate } from '../features/shared.js';

/**
 * International rugby data.
 *
 * NOTE: the spec's World Rugby Rankings endpoint (api.wr-rss.com/.../rankings/mru)
 * is unreachable from here (DNS/timeout). We therefore compute our OWN World-
 * Rugby-style ELO from ESPN international results — replaying every test match
 * chronologically — which is self-contained, free, and equivalent in purpose.
 * (Same self-computed-ELO approach used for tennis.)
 *
 * Sources: ESPN scoreboards for national-team competitions. Stored in
 * intl_rugby_fixtures + intl_rugby_elo (ELO snapshot per country per match date).
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/rugby';
const SOURCE = 'espn_intl';
const K = 40;       // rugby ELO K-factor
const INIT = 1500;

// ESPN competition id → (name, match_type).
const COMPETITIONS: Array<{ id: string; name: string; type: 'friendly' | 'qualifier' | 'final_tournament' }> = [
  { id: '180659', name: 'Six Nations', type: 'final_tournament' },
  { id: '244293', name: 'Rugby Championship', type: 'final_tournament' },
  { id: '164205', name: 'Rugby World Cup', type: 'final_tournament' },
  { id: '289234', name: 'International Test Match', type: 'friendly' },
];

interface EspnEvent {
  id: string;
  date: string;
  status: { type: { completed: boolean } };
  competitions: Array<{ neutralSite?: boolean; competitors: Array<{ homeAway: 'home' | 'away'; team: { displayName: string }; score?: string }> }>;
}

function yyyymmdd(d: Date): string { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

// Pull events for a competition across a wide date range (history) + forward.
async function fetchEvents(id: string): Promise<EspnEvent[]> {
  const out: EspnEvent[] = [];
  const seen = new Set<string>();
  // Year-by-year sweep 2015..now+1, plus a forward 60-day window for fixtures.
  const year = new Date().getUTCFullYear();
  for (let y = 2015; y <= year; y++) {
    const url = `${BASE}/${id}/scoreboard?dates=${y}0101-${y}1231`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = (await res.json()) as { events?: EspnEvent[] };
      for (const e of data.events ?? []) { if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } }
    } catch { /* skip */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  // Forward window for upcoming fixtures.
  for (let off = 0; off <= 60; off += 1) {
    const d = yyyymmdd(new Date(Date.now() + off * 86_400_000));
    try {
      const res = await fetch(`${BASE}/${id}/scoreboard?dates=${d}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { events?: EspnEvent[] };
      for (const e of data.events ?? []) { if (!seen.has(e.id)) { seen.add(e.id); out.push(e); } }
    } catch { /* skip */ }
  }
  return out;
}

export async function ingestIntlRugby(): Promise<void> {
  await withRunLog('rugby', 'intl_espn', async ({ addRows, note }) => {
    interface Parsed {
      id: string; date: Date; home: string; away: string; neutral: boolean;
      hs: number | null; as: number | null; competition: string; type: string; done: boolean;
    }
    const all: Parsed[] = [];
    for (const comp of COMPETITIONS) {
      const events = await fetchEvents(comp.id);
      for (const e of events) {
        const c = e.competitions[0];
        if (!c) continue;
        const home = c.competitors.find((x) => x.homeAway === 'home');
        const away = c.competitors.find((x) => x.homeAway === 'away');
        if (!home || !away) continue;
        const date = new Date(e.date);
        if (isNaN(date.getTime())) continue;
        const done = e.status.type.completed;
        const hs = done ? parseInt(home.score ?? '', 10) : null;
        const as = done ? parseInt(away.score ?? '', 10) : null;
        all.push({
          id: e.id, date, home: home.team.displayName, away: away.team.displayName,
          neutral: c.neutralSite ?? false, hs: isNaN(hs as number) ? null : hs,
          as: isNaN(as as number) ? null : as, competition: comp.name, type: comp.type,
          done: done && hs != null && as != null,
        });
      }
      note(`${comp.name}: ${events.length} events`);
    }

    // Sort chronologically and replay ELO; snapshot pre-match rating per country.
    all.sort((a, b) => a.date.getTime() - b.date.getTime());
    const elo = new Map<string, number>();

    for (const m of all) {
      const he = elo.get(m.home) ?? INIT;
      const ae = elo.get(m.away) ?? INIT;

      // Store fixture.
      await prisma.intlRugbyFixture.upsert({
        where: { source_sourceMatchId: { source: SOURCE, sourceMatchId: m.id } },
        create: {
          source: SOURCE, sourceMatchId: m.id, homeCountry: m.home, awayCountry: m.away,
          competition: m.competition, matchType: m.type, kickoffUtc: m.date,
          neutralVenue: m.neutral, status: m.done ? 'FINAL' : 'SCHEDULED',
          homeScore: m.done ? m.hs : null, awayScore: m.done ? m.as : null,
        },
        update: {
          status: m.done ? 'FINAL' : 'SCHEDULED',
          ...(m.done ? { homeScore: m.hs, awayScore: m.as } : {}),
        },
      });
      // Snapshot pre-match ELO (as-of, leak-free) for both sides.
      const dateOnly = new Date(Date.UTC(m.date.getUTCFullYear(), m.date.getUTCMonth(), m.date.getUTCDate()));
      for (const [country, rating] of [[m.home, he], [m.away, ae]] as const) {
        await prisma.intlRugbyElo.upsert({
          where: { country_date: { country, date: dateOnly } },
          create: { country, rating, date: dateOnly },
          update: { rating },
        });
      }
      addRows(1);

      // Update ELO after the match (played only).
      if (m.done && m.hs != null && m.as != null) {
        const score = m.hs > m.as ? 1 : m.hs === m.as ? 0.5 : 0;
        const hfa = m.neutral ? 0 : 40; // home advantage in rating points
        const [nh, na] = eloUpdate(he, ae, score, K, hfa);
        elo.set(m.home, nh);
        elo.set(m.away, na);
      }
    }
    note(`${all.length} intl rugby matches processed, ${elo.size} countries`);
  });
}
