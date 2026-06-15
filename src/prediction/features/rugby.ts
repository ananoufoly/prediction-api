import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { mean, daysBetween, lastN, persistFeatures, type FeatureRow } from './shared.js';

/**
 * Rugby feature engineering from rugby_matches.
 *
 * Features (home perspective): rolling points scored/conceded over prior 5
 * matches, home/away, H2H (prior meetings + home wins), days rest, competition
 * stage ordinal. Rugby data is sparse, so windows are often short — features
 * degrade to null gracefully.
 */

interface RM {
  id: string;
  competition: string;
  kickoffUtc: Date;
  homeTeam: string;
  awayTeam: string;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
}

interface TeamGame { date: Date; pf: number; pa: number; }

// Knockout-stage hint from competition + (we lack explicit round) — kept simple:
// league competitions are "regular" (1); Six Nations / Rugby Championship are
// table-based internationals (2). A finer stage needs round data ESPN omits here.
function stageOrdinal(competition: string): number {
  if (competition === 'Six Nations' || competition === 'Rugby Championship') return 2;
  return 1;
}

export async function computeRugbyFeatures(opts?: { since?: Date }): Promise<void> {
  await withRunLog('rugby', 'features', async ({ addRows, note }) => {
    // Include upcoming SCHEDULED matches so they get feature rows too (rugby is
    // skipped at prediction time → insufficient_data, but the fixtures should
    // still surface on the dashboard).
    const matches = (await prisma.rugbyMatch.findMany({
      where: { status: { in: ['FINAL', 'SCHEDULED'] } },
      orderBy: { kickoffUtc: 'asc' },
      select: {
        id: true, competition: true, kickoffUtc: true, homeTeam: true, awayTeam: true,
        status: true, homeScore: true, awayScore: true,
      },
    })) as RM[];

    // History/windows use only FINAL matches with scores.
    const finals = matches.filter((m) => m.status === 'FINAL' && m.homeScore != null && m.awayScore != null);
    if (finals.length === 0) { note('no FINAL rugby matches with scores — sparse data'); }

    const hist = new Map<string, TeamGame[]>();
    const h2h = new Map<string, Array<{ date: Date; home: string; hs: number; as: number }>>();
    const h2hKey = (a: string, b: string) => [a, b].sort().join('::');
    for (const m of finals) {
      if (!hist.has(m.homeTeam)) hist.set(m.homeTeam, []);
      if (!hist.has(m.awayTeam)) hist.set(m.awayTeam, []);
      hist.get(m.homeTeam)!.push({ date: m.kickoffUtc, pf: m.homeScore!, pa: m.awayScore! });
      hist.get(m.awayTeam)!.push({ date: m.kickoffUtc, pf: m.awayScore!, pa: m.homeScore! });
      const hk = h2hKey(m.homeTeam, m.awayTeam);
      if (!h2h.has(hk)) h2h.set(hk, []);
      h2h.get(hk)!.push({ date: m.kickoffUtc, home: m.homeTeam, hs: m.homeScore!, as: m.awayScore! });
    }

    const beforeIdx = (arr: { date: Date }[], date: Date) => {
      let i = arr.length;
      while (i > 0 && arr[i - 1]!.date >= date) i--;
      return i;
    };
    const roll = (prior: TeamGame[], n: number) => {
      const w = lastN(prior, n);
      return { pf: mean(w.map((x) => x.pf)), pa: mean(w.map((x) => x.pa)) };
    };

    // Featurize all matches (FINAL → with target; SCHEDULED upcoming → no target).
    const targets = opts?.since ? matches.filter((m) => m.kickoffUtc >= opts.since!) : matches;

    const rows: FeatureRow[] = [];
    for (const m of targets) {
      const homeHist = hist.get(m.homeTeam) ?? [];
      const awayHist = hist.get(m.awayTeam) ?? [];
      const homePrior = homeHist.slice(0, beforeIdx(homeHist, m.kickoffUtc));
      const awayPrior = awayHist.slice(0, beforeIdx(awayHist, m.kickoffUtc));

      const hr = roll(homePrior, 5);
      const ar = roll(awayPrior, 5);
      const homeRest = homePrior.length ? daysBetween(m.kickoffUtc, homePrior[homePrior.length - 1]!.date) : null;
      const awayRest = awayPrior.length ? daysBetween(m.kickoffUtc, awayPrior[awayPrior.length - 1]!.date) : null;

      const meetings = (h2h.get(h2hKey(m.homeTeam, m.awayTeam)) ?? []).filter((x) => x.date < m.kickoffUtc);
      const last5 = lastN(meetings, 5);
      let h2hHomeWins = 0;
      for (const x of last5) {
        const curHomeWasHome = x.home === m.homeTeam;
        const pf = curHomeWasHome ? x.hs : x.as;
        const pa = curHomeWasHome ? x.as : x.hs;
        if (pf > pa) h2hHomeWins++;
      }

      const target = m.status === 'FINAL' && m.homeScore != null && m.awayScore != null
        ? (m.homeScore > m.awayScore ? 1 : 0)
        : null;

      rows.push({
        matchKey: m.id,
        league: m.competition,
        kickoffUtc: m.kickoffUtc,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        features: {
          target_home_win: target,
          home_points_for_l5: hr.pf, home_points_against_l5: hr.pa,
          away_points_for_l5: ar.pf, away_points_against_l5: ar.pa,
          points_form_diff: hr.pf != null && ar.pf != null ? (hr.pf - hr.pa!) - (ar.pf - ar.pa!) : null,
          home_rest_days: homeRest, away_rest_days: awayRest,
          h2h_matches: last5.length, h2h_home_wins: h2hHomeWins,
          competition_stage: stageOrdinal(m.competition),
          home_field: 1,
        },
      });
    }

    const n = await persistFeatures('rugby', rows);
    addRows(n);
    note(`${n} matches featurized (${finals.length} finals available)`);
  });
}
