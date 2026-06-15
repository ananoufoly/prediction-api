import { prisma } from '../db.js';
import { normalizeTeam } from './teamNorm.js';

const ESPN_BASE = 'https://site.api.espn.com/apis/v2/sports/soccer';

// ESPN league slugs → our league names
const LEAGUE_MAP: Array<{ slug: string; league: string }> = [
  { slug: 'eng.1',       league: 'EPL' },
  { slug: 'esp.1',       league: 'La Liga' },
  { slug: 'ita.1',       league: 'Serie A' },
  { slug: 'fra.1',       league: 'Ligue 1' },
  { slug: 'ger.1',       league: 'Bundesliga' },
  { slug: 'ned.1',       league: 'Eredivisie' },
  { slug: 'por.1',       league: 'Liga Portugal' },
  { slug: 'tur.1',       league: 'Süper Lig' },
  { slug: 'jpn.1',       league: 'J League' },
  { slug: 'kor.1',       league: 'K League 1' },
  { slug: 'usa.1',       league: 'MLS' },
];

// European leagues run Aug–May; season named after start year (2025 = 2025/26).
// Calendar-year leagues use the current year.
const now = new Date();
const calYear = now.getFullYear();
const europeSeason = now.getMonth() >= 6 ? calYear : calYear - 1;

const CALENDAR_YEAR_LEAGUES = new Set(['J League', 'K League 1', 'MLS']);

function seasonFor(league: string): number {
  return CALENDAR_YEAR_LEAGUES.has(league) ? calYear : europeSeason;
}

interface EspnEntry {
  team: { displayName: string };
  note?: { text?: string };
  stats: Array<{ name: string; value?: number; displayValue?: string }>;
}

async function fetchEspnStandings(slug: string): Promise<EspnEntry[]> {
  const res = await fetch(`${ESPN_BASE}/${slug}/standings`);
  if (!res.ok) throw new Error(`ESPN standings ${slug}: HTTP ${res.status}`);
  const data = await res.json() as { children: Array<{ standings: { entries: EspnEntry[] } }> };
  return data.children?.[0]?.standings?.entries ?? [];
}

export async function ingestStandings(leagues?: string[]): Promise<void> {
  const targets = leagues
    ? LEAGUE_MAP.filter((l) => leagues.includes(l.league))
    : LEAGUE_MAP;

  for (const { slug, league } of targets) {
    try {
      const entries = await fetchEspnStandings(slug);
      if (entries.length === 0) {
        console.log(`[standings] ${league}: no data from ESPN`);
        continue;
      }

      const season = seasonFor(league);
      const totalTeams = entries.length;

      for (const entry of entries) {
        const statMap = new Map(entry.stats.map((s) => [s.name, s.value ?? 0]));
        const rank    = Math.round(statMap.get('rank') ?? 0);
        const points  = Math.round(statMap.get('points') ?? 0);
        const played  = Math.round(statMap.get('gamesPlayed') ?? 0);
        const note    = entry.note?.text ?? null;

        const rawName  = entry.team.displayName;
        const normName = normalizeTeam(rawName);

        const upsertData = {
          rank,
          points,
          played,
          matchesTotal: totalTeams,
          description: note || null,
          fetchedAt: new Date(),
        };

        // Upsert under both raw and normalized names for resilient lookup
        for (const teamName of new Set([rawName, normName])) {
          await prisma.leagueStanding.upsert({
            where: { league_season_team: { league, season, team: teamName } },
            update: upsertData,
            create: { league, season, team: teamName, ...upsertData },
          });
        }
      }

      console.log(`[standings] ${league} season=${season}: ${entries.length} teams ingested`);
    } catch (err) {
      console.error(`[standings] ${league} failed:`, err);
    }

    // Small delay to be polite to ESPN
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function getLeagueStandings(
  league: string,
  season?: number,
): Promise<Map<string, { rank: number; points: number; played: number; matchesTotal: number; description: string | null }>> {
  const targetSeason = season ?? seasonFor(league);

  const rows = await prisma.leagueStanding.findMany({
    where: { league, season: targetSeason },
  });

  const map = new Map<string, { rank: number; points: number; played: number; matchesTotal: number; description: string | null }>();
  for (const r of rows) {
    map.set(r.team, {
      rank: r.rank,
      points: r.points,
      played: r.played,
      matchesTotal: r.matchesTotal,
      description: r.description,
    });
  }
  return map;
}
