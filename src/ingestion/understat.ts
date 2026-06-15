import { prisma } from '../db.js';

const BASE = 'https://understat.com';

// Understat league slugs
const LEAGUE_SLUGS: Record<string, string> = {
  'EPL': 'EPL',
  'La Liga': 'La_liga',
  'Bundesliga': 'Bundesliga',
  'Serie A': 'Serie_A',
  'Ligue 1': 'Ligue_1',
};

interface UnderstatMatch {
  id: string;
  h: { title: string };
  a: { title: string };
  datetime: string;
  xG: { h: string; a: string };
  goals: { h: string; a: string };
  isResult: boolean;
}

function extractJson(html: string, varName: string): unknown {
  const re = new RegExp(`var ${varName}\\s*=\\s*JSON\\.parse\\('([^']+)'\\)`);
  const match = re.exec(html);
  if (!match?.[1]) return null;
  // Understat JSON-encodes special chars
  return JSON.parse(match[1].replace(/\\x/g, '%').replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
}

export async function fetchUnderstatXg(league: string, season: number): Promise<void> {
  const slug = LEAGUE_SLUGS[league];
  if (!slug) {
    console.warn(`[understat] No slug for league: ${league}`);
    return;
  }

  const url = `${BASE}/league/${slug}/${season}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; betting-research-bot/1.0)' },
  });

  if (!res.ok) {
    throw new Error(`Understat fetch error: ${res.status} for ${url}`);
  }

  const html = await res.text();
  const raw = extractJson(html, 'datesData');

  if (!Array.isArray(raw)) {
    console.warn(`[understat] Could not parse datesData for ${league}/${season}`);
    return;
  }

  const matches = raw as UnderstatMatch[];
  const finished = matches.filter((m) => m.isResult);

  let updated = 0;
  for (const m of finished) {
    const kickoffUtc = new Date(m.datetime.replace(' ', 'T') + 'Z');
    const homeXg = parseFloat(m.xG.h);
    const awayXg = parseFloat(m.xG.a);
    const homeGoals = parseInt(m.goals.h, 10);
    const awayGoals = parseInt(m.goals.a, 10);

    // Match by teams + approximate kickoff (within 3 hours to handle timezone drift)
    const windowStart = new Date(kickoffUtc.getTime() - 3 * 3600 * 1000);
    const windowEnd = new Date(kickoffUtc.getTime() + 3 * 3600 * 1000);

    const homeWord = m.h.title.split(' ')[0] ?? m.h.title;
    const awayWord = m.a.title.split(' ')[0] ?? m.a.title;

    const existing = await prisma.match.findFirst({
      where: {
        league,
        homeTeam: { contains: homeWord, mode: 'insensitive' },
        awayTeam: { contains: awayWord, mode: 'insensitive' },
        kickoffUtc: { gte: windowStart, lte: windowEnd },
      },
    });

    if (existing) {
      await prisma.match.update({
        where: { id: existing.id },
        data: { homeXg, awayXg, homeGoals, awayGoals, status: 'FINAL' },
      });
      updated++;
    }
  }

  console.log(`[understat] ${league}/${season} — updated ${updated}/${finished.length} finished matches`);
}

export async function backfillUnderstat(season = 2024): Promise<void> {
  for (const league of Object.keys(LEAGUE_SLUGS)) {
    try {
      await fetchUnderstatXg(league, season);
    } catch (err) {
      console.error(`[understat] Failed for ${league}/${season}:`, err);
    }
  }
}
