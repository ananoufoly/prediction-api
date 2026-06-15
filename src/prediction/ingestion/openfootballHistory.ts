import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';

/**
 * Extended OpenFootball history loader for the PREDICTION ENGINE.
 *
 * Separate from the edge model's `src/ingestion/openfootball.ts` (which writes
 * to `Match`). This writes to `football_fixtures` with source='openfootball',
 * pulling as many seasons back as OpenFootball publishes for our leagues.
 *
 * Verified available range (2026-06-15): 2015-16 … 2025-26 for the big five.
 * Earlier seasons exist for some leagues; we probe and skip 404s gracefully.
 */

const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';
const SOURCE = 'openfootball';

const LEAGUE_SLUGS: Array<{ league: string; slug: string }> = [
  { league: 'EPL', slug: 'en.1' },
  { league: 'La Liga', slug: 'es.1' },
  { league: 'Bundesliga', slug: 'de.1' },
  { league: 'Serie A', slug: 'it.1' },
  { league: 'Ligue 1', slug: 'fr.1' },
];

// Season folder labels, newest first. Probed individually; 404 → skip.
const SEASONS = [
  '2025-26', '2024-25', '2023-24', '2022-23', '2021-22',
  '2020-21', '2019-20', '2018-19', '2017-18', '2016-17', '2015-16',
];

interface OfMatch {
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: { ft?: [number, number] };
}
interface OfData {
  matches?: OfMatch[];
  rounds?: Array<{ matches: OfMatch[] }>;
}

function extractMatches(d: OfData): OfMatch[] {
  if (Array.isArray(d.matches)) return d.matches;
  if (Array.isArray(d.rounds)) return d.rounds.flatMap((r) => r.matches);
  return [];
}

// Season label "2023-24" → start-year season number 2023.
function seasonNumber(label: string): number {
  return parseInt(label.slice(0, 4), 10);
}

export async function ingestOpenfootballHistory(opts?: { seasons?: string[] }): Promise<void> {
  const seasons = opts?.seasons ?? SEASONS;

  await withRunLog('football', SOURCE, async ({ addRows, note }) => {
    for (const { league, slug } of LEAGUE_SLUGS) {
      for (const seasonLabel of seasons) {
        const url = `${BASE}/${seasonLabel}/${slug}.json`;
        try {
          const res = await fetch(url);
          if (res.status === 404) continue; // season not published for this league
          if (!res.ok) {
            note(`${league} ${seasonLabel}: HTTP ${res.status}`);
            continue;
          }
          const data = (await res.json()) as OfData;
          const matches = extractMatches(data);
          if (matches.length === 0) continue;

          const season = seasonNumber(seasonLabel);
          for (const m of matches) {
            const dateStr = m.time ? `${m.date}T${m.time}:00Z` : `${m.date}T12:00:00Z`;
            const kickoffUtc = new Date(dateStr);
            if (isNaN(kickoffUtc.getTime())) continue;
            const hasFt = m.score?.ft != null && m.score.ft.length === 2;
            const status = hasFt ? 'FINAL' : 'SCHEDULED';
            // Synthesize a stable id since OpenFootball has none.
            const sourceMatchId = `${slug}-${seasonLabel}-${m.date}-${m.team1}-${m.team2}`
              .replace(/\s+/g, '_');

            await prisma.footballFixture.upsert({
              where: { source_sourceMatchId: { source: SOURCE, sourceMatchId } },
              create: {
                source: SOURCE,
                sourceMatchId,
                league,
                season,
                kickoffUtc,
                homeTeam: m.team1,
                awayTeam: m.team2,
                status,
                homeGoals: hasFt ? m.score!.ft![0] : null,
                awayGoals: hasFt ? m.score!.ft![1] : null,
              },
              update: {
                status,
                ...(hasFt ? { homeGoals: m.score!.ft![0], awayGoals: m.score!.ft![1] } : {}),
              },
            });
            addRows(1);
          }
        } catch (err) {
          note(`${league} ${seasonLabel} failed: ${(err as Error).message}`);
        }
      }
    }
  });
}
