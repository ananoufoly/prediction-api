import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { lastN, daysBetween, persistFeatures, type FeatureRow } from './shared.js';

/**
 * Feature engineering for INTERNATIONAL matches (football + rugby), stored under
 * sport='football_intl' / 'rugby_intl'. Independent of the club feature builders.
 *
 * Per fixture, leak-free as-of kickoff:
 *   elo_home, elo_away, elo_diff, home_advantage (0 at neutral venues),
 *   match_weight (friendly .3 / qualifier .7 / final_tournament 1.0),
 *   rest_days_home, rest_days_away, h2h_last_5 (home wins − away wins, last 5),
 *   plus target_outcome (football 3-way) / target_home_win (rugby 2-way).
 */

const MATCH_WEIGHT: Record<string, number> = {
  friendly: 0.3, qualifier: 0.7, final_tournament: 1.0,
};

interface Fixture {
  id: string;
  homeCountry: string;
  awayCountry: string;
  competition: string;
  matchType: string;
  kickoffUtc: Date;
  neutralVenue: boolean;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
}

interface EloPoint { date: Date; rating: number }

// Latest ELO at-or-before a date (as-of lookup).
function eloAsOf(series: EloPoint[], date: Date): number | null {
  let val: number | null = null;
  for (const p of series) {
    if (p.date <= date) val = p.rating;
    else break;
  }
  return val;
}

async function build(
  sport: 'football_intl' | 'rugby_intl',
  fixtures: Fixture[],
  eloByCountry: Map<string, EloPoint[]>,
  hasDraw: boolean,
  addRows: (n: number) => void,
): Promise<void> {
  // Per-country chronological played-match history (for rest days + H2H).
  const played = fixtures
    .filter((f) => f.status === 'FINAL' && f.homeScore != null && f.awayScore != null)
    .sort((a, b) => a.kickoffUtc.getTime() - b.kickoffUtc.getTime());

  const lastMatchDate = new Map<string, Date[]>();
  const h2h = new Map<string, Array<{ date: Date; home: string; hs: number; as: number }>>();
  const h2hKey = (a: string, b: string) => [a, b].sort().join('::');
  for (const f of played) {
    for (const c of [f.homeCountry, f.awayCountry]) {
      if (!lastMatchDate.has(c)) lastMatchDate.set(c, []);
      lastMatchDate.get(c)!.push(f.kickoffUtc);
    }
    const k = h2hKey(f.homeCountry, f.awayCountry);
    if (!h2h.has(k)) h2h.set(k, []);
    h2h.get(k)!.push({ date: f.kickoffUtc, home: f.homeCountry, hs: f.homeScore!, as: f.awayScore! });
  }

  const priorDate = (dates: Date[] | undefined, before: Date): Date | null => {
    if (!dates) return null;
    let last: Date | null = null;
    for (const d of dates) { if (d < before) last = d; else break; }
    return last;
  };

  const rows: FeatureRow[] = [];
  for (const f of fixtures) {
    const eloHome = eloAsOf(eloByCountry.get(f.homeCountry) ?? [], f.kickoffUtc);
    const eloAway = eloAsOf(eloByCountry.get(f.awayCountry) ?? [], f.kickoffUtc);

    const hPrev = priorDate(lastMatchDate.get(f.homeCountry), f.kickoffUtc);
    const aPrev = priorDate(lastMatchDate.get(f.awayCountry), f.kickoffUtc);

    const meetings = (h2h.get(h2hKey(f.homeCountry, f.awayCountry)) ?? []).filter((m) => m.date < f.kickoffUtc);
    const last5 = lastN(meetings, 5);
    let h2hNet = 0;
    for (const m of last5) {
      const homeWasHome = m.home === f.homeCountry;
      const hs = homeWasHome ? m.hs : m.as;
      const as = homeWasHome ? m.as : m.hs;
      h2hNet += hs > as ? 1 : hs < as ? -1 : 0;
    }

    const played2 = f.status === 'FINAL' && f.homeScore != null && f.awayScore != null;
    const features: Record<string, number | null> = {
      elo_home: eloHome,
      elo_away: eloAway,
      elo_diff: eloHome != null && eloAway != null ? eloHome - eloAway : null,
      home_advantage: f.neutralVenue ? 0 : 1,
      match_weight: MATCH_WEIGHT[f.matchType] ?? 0.5,
      rest_days_home: hPrev ? daysBetween(f.kickoffUtc, hPrev) : null,
      rest_days_away: aPrev ? daysBetween(f.kickoffUtc, aPrev) : null,
      rest_diff: hPrev && aPrev ? daysBetween(f.kickoffUtc, hPrev) - daysBetween(f.kickoffUtc, aPrev) : null,
      h2h_last_5: last5.length ? h2hNet : null,
    };
    if (hasDraw) {
      features['target_outcome'] = played2
        ? (f.homeScore! > f.awayScore! ? 0 : f.homeScore! === f.awayScore! ? 1 : 2)
        : null;
    } else {
      features['target_home_win'] = played2 ? (f.homeScore! > f.awayScore! ? 1 : 0) : null;
    }

    rows.push({
      matchKey: f.id,
      league: f.competition,
      kickoffUtc: f.kickoffUtc,
      homeTeam: f.homeCountry,
      awayTeam: f.awayCountry,
      features,
    });
  }

  const n = await persistFeatures(sport, rows);
  addRows(n);
}

export async function computeIntlFootballFeatures(): Promise<void> {
  await withRunLog('football', 'features_intl', async ({ addRows, note }) => {
    const fixtures = (await prisma.intlFootballFixture.findMany({
      orderBy: { kickoffUtc: 'asc' },
      select: {
        id: true, homeCountry: true, awayCountry: true, competition: true, matchType: true,
        kickoffUtc: true, neutralVenue: true, status: true, homeScore: true, awayScore: true,
      },
    })) as Fixture[];
    if (fixtures.length === 0) { note('no intl football fixtures'); return; }

    const eloRows = await prisma.intlFootballElo.findMany({ orderBy: { date: 'asc' }, select: { country: true, eloRating: true, date: true } });
    const eloByCountry = new Map<string, EloPoint[]>();
    for (const e of eloRows) {
      if (!eloByCountry.has(e.country)) eloByCountry.set(e.country, []);
      eloByCountry.get(e.country)!.push({ date: e.date, rating: e.eloRating });
    }

    await build('football_intl', fixtures, eloByCountry, true, addRows);
    note(`${fixtures.length} fixtures, ${eloByCountry.size} countries with ELO`);
  });
}

export async function computeIntlRugbyFeatures(): Promise<void> {
  await withRunLog('rugby', 'features_intl', async ({ addRows, note }) => {
    const fixtures = (await prisma.intlRugbyFixture.findMany({
      orderBy: { kickoffUtc: 'asc' },
      select: {
        id: true, homeCountry: true, awayCountry: true, competition: true, matchType: true,
        kickoffUtc: true, neutralVenue: true, status: true, homeScore: true, awayScore: true,
      },
    })) as Fixture[];
    if (fixtures.length === 0) { note('no intl rugby fixtures'); return; }

    const eloRows = await prisma.intlRugbyElo.findMany({ orderBy: { date: 'asc' }, select: { country: true, rating: true, date: true } });
    const eloByCountry = new Map<string, EloPoint[]>();
    for (const e of eloRows) {
      if (!eloByCountry.has(e.country)) eloByCountry.set(e.country, []);
      eloByCountry.get(e.country)!.push({ date: e.date, rating: e.rating });
    }

    await build('rugby_intl', fixtures, eloByCountry, false, addRows);
    note(`${fixtures.length} fixtures, ${eloByCountry.size} countries with ELO`);
  });
}
