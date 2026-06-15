import { prisma } from '../db.js';

const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master';

const FIXTURES: Array<{ league: string; url: string }> = [
  { league: 'EPL', url: `${BASE}/2023-24/en.1.json` },
  { league: 'EPL', url: `${BASE}/2024-25/en.1.json` },
  { league: 'La Liga', url: `${BASE}/2023-24/es.1.json` },
  { league: 'La Liga', url: `${BASE}/2024-25/es.1.json` },
  { league: 'Bundesliga', url: `${BASE}/2023-24/de.1.json` },
  { league: 'Bundesliga', url: `${BASE}/2024-25/de.1.json` },
  { league: 'Serie A', url: `${BASE}/2023-24/it.1.json` },
  { league: 'Serie A', url: `${BASE}/2024-25/it.1.json` },
];

interface OpenFootballMatch {
  round?: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: { ft: [number, number]; ht?: [number, number] };
}

// API returns flat matches array (not nested rounds)
interface OpenFootballData {
  name?: string;
  matches?: OpenFootballMatch[];
  // Older format had rounds
  rounds?: Array<{ name: string; matches: OpenFootballMatch[] }>;
}

function extractMatches(data: OpenFootballData): OpenFootballMatch[] {
  if (Array.isArray(data.matches)) return data.matches;
  if (Array.isArray(data.rounds)) return data.rounds.flatMap((r) => r.matches);
  return [];
}

export async function backfillOpenfootball(): Promise<void> {
  let totalInserted = 0;

  for (const fixture of FIXTURES) {
    try {
      const res = await fetch(fixture.url);
      if (!res.ok) {
        console.warn(`[openfootball] ${fixture.url} — ${res.status}, skipping`);
        continue;
      }

      const data = (await res.json()) as OpenFootballData;
      const matches = extractMatches(data);
      if (matches.length === 0) {
        console.warn(`[openfootball] ${fixture.url} — no matches found in response`);
        continue;
      }

      let inserted = 0;
      for (const m of matches) {
        const dateStr = m.time ? `${m.date}T${m.time}Z` : `${m.date}T12:00:00Z`;
        const kickoffUtc = new Date(dateStr);
        const hasFt = m.score?.ft != null && m.score.ft.length === 2;
        const status = hasFt ? 'FINAL' : 'SCHEDULED';
        const homeGoals = hasFt ? m.score!.ft[0] ?? null : null;
        const awayGoals = hasFt ? m.score!.ft[1] ?? null : null;

        await prisma.match.upsert({
          where: {
            league_homeTeam_awayTeam_kickoffUtc: {
              league: fixture.league,
              homeTeam: m.team1,
              awayTeam: m.team2,
              kickoffUtc,
            },
          },
          create: {
            league: fixture.league,
            homeTeam: m.team1,
            awayTeam: m.team2,
            kickoffUtc,
            status,
            homeGoals,
            awayGoals,
          },
          update: {
            status,
            ...(homeGoals !== null ? { homeGoals, awayGoals } : {}),
          },
        });
        inserted++;
      }

      console.log(`[openfootball] ${fixture.league} ${fixture.url.split('/').slice(-2, -1)[0]} — ${inserted} matches`);
      totalInserted += inserted;
    } catch (err) {
      console.error(`[openfootball] Failed for ${fixture.url}:`, err);
    }
  }

  console.log(`[openfootball] Backfill complete — ${totalInserted} total matches upserted`);
}
