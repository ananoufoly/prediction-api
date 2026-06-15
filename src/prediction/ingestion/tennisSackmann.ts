import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';

/**
 * Jeff Sackmann tennis_atp / tennis_wta loader.
 *   https://github.com/JeffSackmann/tennis_atp
 *   https://github.com/JeffSackmann/tennis_wta
 *
 * One CSV per year (atp_matches_YYYY.csv). One-time historical load + cheap
 * incremental updates (re-run the current year to pick up new matches; upsert
 * is idempotent on (tour, tourneyId, winnerId, loserId, round)).
 */

const RAW = 'https://raw.githubusercontent.com/JeffSackmann';

const TOURS: Array<{ tour: 'ATP' | 'WTA'; repo: string; prefix: string }> = [
  { tour: 'ATP', repo: 'tennis_atp', prefix: 'atp' },
  { tour: 'WTA', repo: 'tennis_wta', prefix: 'wta' },
];

// Minimal RFC-4180-ish CSV line splitter (handles quoted fields with commas).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function num(v: string | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// tourney_date is YYYYMMDD.
function parseTourneyDate(v: string): Date | null {
  if (!/^\d{8}$/.test(v)) return null;
  const y = +v.slice(0, 4), m = +v.slice(4, 6), d = +v.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return isNaN(dt.getTime()) ? null : dt;
}

async function loadYear(
  tour: 'ATP' | 'WTA',
  repo: string,
  prefix: string,
  year: number,
  addRows: (n: number) => void,
  note: (s: string) => void,
): Promise<void> {
  const file = `${prefix}_matches_${year}.csv`;
  const url = `${RAW}/${repo}/master/${file}`;
  const res = await fetch(url);
  if (res.status === 404) { note(`${tour} ${year}: not published`); return; }
  if (!res.ok) { note(`${tour} ${year}: HTTP ${res.status}`); return; }

  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return;

  const header = splitCsvLine(lines[0]!);
  const idx = (name: string) => header.indexOf(name);
  const col = {
    tourneyId: idx('tourney_id'),
    tourneyName: idx('tourney_name'),
    surface: idx('surface'),
    tourneyDate: idx('tourney_date'),
    round: idx('round'),
    bestOf: idx('best_of'),
    winnerId: idx('winner_id'),
    winnerName: idx('winner_name'),
    winnerRank: idx('winner_rank'),
    loserId: idx('loser_id'),
    loserName: idx('loser_name'),
    loserRank: idx('loser_rank'),
    score: idx('score'),
  };

  for (let i = 1; i < lines.length; i++) {
    const f = splitCsvLine(lines[i]!);
    const tourneyId = f[col.tourneyId] ?? '';
    const winnerName = f[col.winnerName] ?? '';
    const loserName = f[col.loserName] ?? '';
    if (!tourneyId || !winnerName || !loserName) continue;

    const tourneyDate = parseTourneyDate(f[col.tourneyDate] ?? '');
    if (!tourneyDate) continue;
    const round = f[col.round] || null;
    const winnerId = num(f[col.winnerId]);
    const loserId = num(f[col.loserId]);

    await prisma.tennisMatch.upsert({
      where: {
        tour_tourneyId_winnerId_loserId_round: {
          tour,
          tourneyId,
          // Composite unique requires non-null ints; fall back to 0 when missing.
          winnerId: winnerId ?? 0,
          loserId: loserId ?? 0,
          round: round ?? '',
        },
      },
      create: {
        tour,
        sourceFile: file,
        tourneyId,
        tourneyName: f[col.tourneyName] ?? '',
        tourneyDate,
        surface: f[col.surface] || null,
        round,
        bestOf: num(f[col.bestOf]) ? Math.round(num(f[col.bestOf])!) : null,
        winnerName,
        winnerId,
        winnerRank: num(f[col.winnerRank]) ? Math.round(num(f[col.winnerRank])!) : null,
        loserName,
        loserId,
        loserRank: num(f[col.loserRank]) ? Math.round(num(f[col.loserRank])!) : null,
        score: f[col.score] || null,
      },
      update: {
        surface: f[col.surface] || null,
        score: f[col.score] || null,
      },
    });
    addRows(1);
  }
  note(`${tour} ${year}: ${lines.length - 1} matches`);
}

/**
 * @param fromYear earliest year to load (default 2000 — full historical load).
 * @param toYear   latest year (default current year for incremental top-up).
 */
export async function ingestTennisSackmann(opts?: {
  fromYear?: number;
  toYear?: number;
  tours?: Array<'ATP' | 'WTA'>;
}): Promise<void> {
  // Current year computed without Date.now in scripts; here we're in app code so it's fine.
  const thisYear = new Date().getUTCFullYear();
  const fromYear = opts?.fromYear ?? 2000;
  const toYear = opts?.toYear ?? thisYear;
  const tours = opts?.tours
    ? TOURS.filter((t) => opts.tours!.includes(t.tour))
    : TOURS;

  await withRunLog('tennis', 'sackmann', async ({ addRows, note }) => {
    for (const { tour, repo, prefix } of tours) {
      for (let year = fromYear; year <= toYear; year++) {
        try {
          await loadYear(tour, repo, prefix, year, addRows, note);
        } catch (err) {
          note(`${tour} ${year} failed: ${(err as Error).message}`);
        }
      }
    }
  });
}
