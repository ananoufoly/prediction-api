import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';

/**
 * International football data from eloratings.net (free).
 *
 *  - World.tsv          → current ELO per country (ISO code, rating)
 *  - <Country>.tsv      → that country's full match history with the ELO of BOTH
 *                         sides AS-OF each match (leak-free), score, competition,
 *                         and neutral-venue flag. Each match appears in both
 *                         countries' files, so we dedup on a canonical key.
 *  - fixtures.tsv       → upcoming international fixtures with inline ELO.
 *
 * Stored in intl_football_elo + intl_football_fixtures (status FINAL/SCHEDULED).
 */

const BASE = 'https://www.eloratings.net';
const SOURCE = 'eloratings';

// A spread of strong national teams whose files together cover the vast majority
// of competitive internationals. Each match is shared, so this set yields a dense
// historical table without fetching all ~240 countries.
const COUNTRY_FILES = [
  'Spain', 'Brazil', 'Germany', 'France', 'England', 'Argentina', 'Italy',
  'Netherlands', 'Portugal', 'Belgium', 'Croatia', 'Uruguay', 'Colombia',
  'Mexico', 'USA', 'Japan', 'South_Korea', 'Senegal', 'Morocco', 'Nigeria',
  'Cameroon', 'Ghana', 'Egypt', 'Australia', 'Switzerland', 'Denmark',
  'Sweden', 'Poland', 'Serbia', 'Austria', 'Wales', 'Scotland', 'Ukraine',
  'Ecuador', 'Peru', 'Chile', 'Ivory_Coast', 'Algeria', 'Tunisia', 'Iran',
];

// Competition code → match_type. Final tournaments are everything not a
// friendly or a qualifier.
const QUALIFIER_CODES = new Set(['WQ', 'EQ', 'CQ', 'AQ', 'NQ', 'OQ', 'CCQ']);
const FRIENDLY_CODES = new Set(['F', 'FT']);
function matchType(code: string): 'friendly' | 'qualifier' | 'final_tournament' {
  if (FRIENDLY_CODES.has(code)) return 'friendly';
  if (QUALIFIER_CODES.has(code) || code.endsWith('Q')) return 'qualifier';
  return 'final_tournament';
}

const COMP_NAME: Record<string, string> = {
  F: 'Friendly', WC: 'FIFA World Cup', WQ: 'World Cup Qualifier',
  EC: 'UEFA Euro', EQ: 'Euro Qualifier', CA: 'Copa América', SA: 'Copa América',
  BC: 'Continental Qualifier', CC: 'Confederations Cup', OG: 'Olympics',
  ENL: 'UEFA Nations League', ENA: 'Africa Cup of Nations', NWT: 'Nations League',
};
function compName(code: string): string {
  return COMP_NAME[code] ?? code;
}

function parseDate(y: string, m: string, d: string): Date | null {
  const day = d === '00' ? '15' : d; // some fixtures have unknown day
  const dt = new Date(Date.UTC(+y, +m - 1, +day));
  return isNaN(dt.getTime()) ? null : dt;
}

// Canonical match id independent of which country's file it came from.
function matchKey(date: string, a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `${date}-${x}-${y}`;
}

async function ingestEloTable(addRows: (n: number) => void): Promise<void> {
  const res = await fetch(`${BASE}/World.tsv`);
  if (!res.ok) throw new Error(`World.tsv HTTP ${res.status}`);
  const text = await res.text();
  const today = new Date();
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (const line of text.split('\n')) {
    const c = line.split('\t');
    if (c.length < 4) continue;
    const country = c[2];
    const elo = Number(c[3]);
    if (!country || !Number.isFinite(elo)) continue;
    await prisma.intlFootballElo.upsert({
      where: { country_date: { country, date } },
      create: { country, eloRating: elo, date },
      update: { eloRating: elo },
    });
    addRows(1);
  }
}

interface PendingFixture {
  key: string; home: string; away: string; code: string; date: Date;
  neutral: boolean; played: boolean; hs: number | null; as: number | null;
}

async function ingestCountryHistory(
  file: string,
  seen: Set<string>,
  fixtureBuf: PendingFixture[],
  eloBuf: Map<string, { country: string; date: Date; rating: number }>,
): Promise<number> {
  const res = await fetch(`${BASE}/${file}.tsv`);
  if (!res.ok) return 0;
  const text = await res.text();
  let n = 0;
  for (const line of text.split('\n')) {
    const c = line.split('\t');
    if (c.length < 12) continue;
    const date = parseDate(c[0]!, c[1]!, c[2]!);
    if (!date) continue;
    const home = c[3], away = c[4];
    if (!home || !away) continue;
    const dstr = date.toISOString().slice(0, 10);
    const key = matchKey(dstr, home, away);
    if (seen.has(key)) continue;
    seen.add(key);

    const hs = c[5] === '' ? null : parseInt(c[5]!, 10);
    const as = c[6] === '' ? null : parseInt(c[6]!, 10);
    const code = c[7] ?? 'F';
    const neutral = (c[8] ?? '') !== '';
    const homeElo = Number(c[10]);
    const awayElo = Number(c[11]);
    const played = hs != null && as != null && !isNaN(hs) && !isNaN(as);

    fixtureBuf.push({ key, home, away, code, date, neutral, played, hs: played ? hs : null, as: played ? as : null });
    // Buffer the as-of ELO snapshots, deduped by (country, date).
    if (Number.isFinite(homeElo)) eloBuf.set(`${home}|${dstr}`, { country: home, date, rating: homeElo });
    if (Number.isFinite(awayElo)) eloBuf.set(`${away}|${dstr}`, { country: away, date, rating: awayElo });
    n++;
  }
  return n;
}

// Bulk-write buffered fixtures + ELO using createMany(skipDuplicates) — far
// faster than per-row upserts for the ~20k historical matches.
async function flushBuffers(
  fixtureBuf: PendingFixture[],
  eloBuf: Map<string, { country: string; date: Date; rating: number }>,
  addRows: (n: number) => void,
): Promise<void> {
  const CHUNK = 1000;
  for (let i = 0; i < fixtureBuf.length; i += CHUNK) {
    const slice = fixtureBuf.slice(i, i + CHUNK);
    await prisma.intlFootballFixture.createMany({
      skipDuplicates: true,
      data: slice.map((f) => ({
        source: SOURCE, sourceMatchId: f.key, homeCountry: f.home, awayCountry: f.away,
        competition: compName(f.code), matchType: matchType(f.code), kickoffUtc: f.date,
        neutralVenue: f.neutral, status: f.played ? 'FINAL' : 'SCHEDULED',
        homeScore: f.hs, awayScore: f.as,
      })),
    });
    addRows(slice.length);
  }
  const eloRows = [...eloBuf.values()].map((e) => ({ country: e.country, date: e.date, eloRating: e.rating }));
  for (let i = 0; i < eloRows.length; i += CHUNK) {
    await prisma.intlFootballElo.createMany({ skipDuplicates: true, data: eloRows.slice(i, i + CHUNK) });
  }
}

// Upcoming fixtures (fixtures.tsv): year month day | home away | comp | venue | ... | home_elo away_elo
async function ingestUpcomingFixtures(addRows: (n: number) => void): Promise<number> {
  const res = await fetch(`${BASE}/fixtures.tsv`);
  if (!res.ok) return 0;
  const text = await res.text();
  let n = 0;
  for (const line of text.split('\n')) {
    const c = line.split('\t');
    if (c.length < 5) continue;
    const date = parseDate(c[0]!, c[1]!, c[2]!);
    if (!date) continue;
    const home = c[3], away = c[4];
    if (!home || !away) continue;
    const code = c[5] ?? 'F';
    const neutral = (c[6] ?? '') !== '';
    const dstr = date.toISOString().slice(0, 10);
    const key = matchKey(dstr, home, away);
    await prisma.intlFootballFixture.upsert({
      where: { source_sourceMatchId: { source: SOURCE, sourceMatchId: key } },
      create: {
        source: SOURCE, sourceMatchId: key, homeCountry: home, awayCountry: away,
        competition: compName(code), matchType: matchType(code),
        kickoffUtc: date, neutralVenue: neutral, status: 'SCHEDULED',
      },
      update: { kickoffUtc: date, competition: compName(code), matchType: matchType(code), neutralVenue: neutral },
    });
    addRows(1);
    n++;
  }
  return n;
}

export async function ingestIntlFootball(): Promise<void> {
  await withRunLog('football', 'intl_eloratings', async ({ addRows, note }) => {
    await ingestEloTable(addRows);
    // Upcoming first so it always runs even if history is large/slow.
    const upc = await ingestUpcomingFixtures(addRows);

    const seen = new Set<string>();
    const fixtureBuf: PendingFixture[] = [];
    const eloBuf = new Map<string, { country: string; date: Date; rating: number }>();
    let hist = 0;
    for (const file of COUNTRY_FILES) {
      try { hist += await ingestCountryHistory(file, seen, fixtureBuf, eloBuf); }
      catch (e) { note(`${file}: ${(e as Error).message}`); }
      await new Promise((r) => setTimeout(r, 120));
    }
    await flushBuffers(fixtureBuf, eloBuf, addRows);
    note(`history ${hist} matches, upcoming ${upc}`);
  });
}
