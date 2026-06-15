import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import { eloExpected, eloUpdate, daysBetween, persistFeatures, type FeatureRow } from './shared.js';

/**
 * Tennis feature engineering from tennis_matches (Jeff Sackmann).
 *
 * Surface-specific ELO is computed by replaying all matches chronologically and
 * updating each player's per-surface rating. For every match we snapshot the
 * PRE-match ratings (leak-free), then apply the update. The match perspective is
 * "winner = home" only for storage; features are oriented A=winner, B=loser, and
 * include the model-facing target (A always won) plus the pre-match ELO win prob
 * so the Phase 3 model can calibrate against actual ranks.
 *
 * Features per match: surface ELO (A, B, diff), pre-match ELO P(A wins), ranks,
 * rank diff, surface H2H (prior meetings on same surface), fatigue (matches in
 * last 14 days), tournament round ordinal.
 */

const K = 32;
const INIT = 1500;

const ROUND_ORDINAL: Record<string, number> = {
  'R128': 1, 'R64': 2, 'R32': 3, 'R16': 4, 'QF': 5, 'SF': 6, 'F': 7,
  'RR': 3, 'BR': 6, // round-robin ~ early; bronze ~ semi-stage
};

interface TMatch {
  id: string;
  tour: string;
  tourneyId: string;
  tourneyDate: Date;
  surface: string | null;
  round: string | null;
  winnerName: string;
  winnerId: number | null;
  winnerRank: number | null;
  loserName: string;
  loserId: number | null;
  loserRank: number | null;
}

export async function computeTennisFeatures(opts?: {
  tours?: Array<'ATP' | 'WTA'>;
  since?: Date;
}): Promise<void> {
  await withRunLog('tennis', 'features', async ({ addRows, note }) => {
    const where: Record<string, unknown> = {};
    if (opts?.tours) where['tour'] = { in: opts.tours };

    const matches = (await prisma.tennisMatch.findMany({
      where,
      orderBy: [{ tourneyDate: 'asc' }, { tourneyId: 'asc' }],
      select: {
        id: true, tour: true, tourneyId: true, tourneyDate: true, surface: true, round: true,
        winnerName: true, winnerId: true, winnerRank: true,
        loserName: true, loserId: true, loserRank: true,
      },
    })) as TMatch[];

    if (matches.length === 0) { note('no tennis matches'); return; }

    // Per (tour, surface, player) ELO; player key by id when present else name.
    const elo = new Map<string, number>();
    const pkey = (tour: string, surface: string, player: string) => `${tour}|${surface}|${player}`;
    const playerId = (id: number | null, name: string) => (id != null && id !== 0 ? `id:${id}` : `nm:${name}`);

    // Per-player recent match dates (for fatigue) and surface H2H ledger.
    const recentDates = new Map<string, Date[]>(); // player -> dates asc
    const h2h = new Map<string, number>(); // "surface|pА|pB(sorted)" -> count of prior meetings; plus wins map
    const h2hWins = new Map<string, number>(); // same key -> wins by lexicographically-first player

    const rows: FeatureRow[] = [];
    for (const m of matches) {
      const surface = m.surface ?? 'Unknown';
      const wId = playerId(m.winnerId, m.winnerName);
      const lId = playerId(m.loserId, m.loserName);
      const wKey = pkey(m.tour, surface, wId);
      const lKey = pkey(m.tour, surface, lId);

      const wElo = elo.get(wKey) ?? INIT;
      const lElo = elo.get(lKey) ?? INIT;

      // Fatigue: matches in the 14 days before this match.
      const fatigue = (pid: string) => {
        const ds = recentDates.get(pid) ?? [];
        return ds.filter((d) => daysBetween(m.tourneyDate, d) >= 0 && daysBetween(m.tourneyDate, d) <= 14).length;
      };
      const wFatigue = fatigue(wId);
      const lFatigue = fatigue(lId);

      // Surface H2H (prior meetings).
      const pair = [wId, lId].sort();
      const hk = `${surface}|${pair[0]}|${pair[1]}`;
      const priorMeetings = h2h.get(hk) ?? 0;
      const firstWins = h2hWins.get(hk) ?? 0;
      // wins by current winner among priors:
      const winnerIsFirst = pair[0] === wId;
      const winnerPriorWins = winnerIsFirst ? firstWins : priorMeetings - firstWins;

      const round = m.round ?? '';
      if (opts?.since == null || m.tourneyDate >= opts.since) {
        rows.push({
          matchKey: `${m.tour}:${m.tourneyId}:${wId}:${lId}:${round}`,
          league: m.tour,
          kickoffUtc: m.tourneyDate,
          homeTeam: m.winnerName, // A = winner
          awayTeam: m.loserName,  // B = loser
          features: {
            // A is always the actual winner → target label is implicitly A wins.
            target_a_wins: 1,
            surface_ordinal: surfaceOrdinal(surface),
            a_surface_elo: wElo,
            b_surface_elo: lElo,
            elo_diff: wElo - lElo,
            elo_p_a_wins: eloExpected(wElo, lElo),
            a_rank: m.winnerRank,
            b_rank: m.loserRank,
            rank_diff: m.winnerRank != null && m.loserRank != null ? m.winnerRank - m.loserRank : null,
            a_fatigue_14d: wFatigue,
            b_fatigue_14d: lFatigue,
            // Directional diffs (A − B) so the model can be symmetrized by pure
            // negation when mirroring to B's perspective (tennis is single-class).
            fatigue_diff: wFatigue - lFatigue,
            surface_h2h_matches: priorMeetings,
            a_surface_h2h_wins: winnerPriorWins,
            surface_h2h_win_diff: winnerPriorWins - (priorMeetings - winnerPriorWins),
            round_ordinal: ROUND_ORDINAL[round] ?? null,
          },
        });
      }

      // --- apply updates AFTER snapshotting ---
      const [newW, newL] = eloUpdate(wElo, lElo, 1, K);
      elo.set(wKey, newW);
      elo.set(lKey, newL);

      for (const pid of [wId, lId]) {
        if (!recentDates.has(pid)) recentDates.set(pid, []);
        recentDates.get(pid)!.push(m.tourneyDate);
      }
      h2h.set(hk, priorMeetings + 1);
      if (winnerIsFirst) h2hWins.set(hk, firstWins + 1);
      else h2hWins.set(hk, firstWins);
    }

    const n = await persistFeatures('tennis', rows);
    addRows(n);
    note(`${n} matches featurized; ${elo.size} player-surface ELOs tracked`);
  });
}

function surfaceOrdinal(s: string): number | null {
  switch (s) {
    case 'Hard': return 1;
    case 'Clay': return 2;
    case 'Grass': return 3;
    case 'Carpet': return 4;
    default: return null;
  }
}
