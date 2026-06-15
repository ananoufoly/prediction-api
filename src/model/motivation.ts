/**
 * Motivation analysis: determines whether a team's league position makes their
 * remaining matches predictable in terms of effort/motivation.
 *
 * A team is "locked in" when the points gap to the nearest zone boundary
 * (relegation, European spots, title) is larger than (remaining games × 3),
 * meaning their final position cannot change regardless of results.
 *
 * This is a filter, not a rating — a locked-in team may still produce normal
 * football, but the distribution of outcomes becomes less predictable due to
 * rotation, low pressure, or conversely extreme pressure.
 */

export type MotivationFlag =
  | 'NORMAL'          // position is still meaningful, nothing unusual
  | 'LOCKED_IN'       // position mathematically cannot change — mid-table comfort
  | 'MUST_WIN'        // fighting relegation or chasing title with narrow margin
  | 'ALREADY_DONE';   // relegated / title won / European spot clinched

export interface MotivationResult {
  flag: MotivationFlag;
  reason: string;
  /** When true, candidate should be dropped (LOCKED_IN or ALREADY_DONE) */
  suppress: boolean;
}

interface Standing {
  rank: number;
  points: number;
  played: number;
  matchesTotal: number;
  description: string | null;
}

function remainingGames(standing: Standing): number {
  // Total games in a round-robin = (matchesTotal - 1) * 2 / matchesTotal * matchesTotal
  // = matchesTotal - 1 home + matchesTotal - 1 away = 2*(matchesTotal-1) per team
  const totalGames = (standing.matchesTotal - 1) * 2;
  return Math.max(0, totalGames - standing.played);
}

function maxPointsGainable(standing: Standing): number {
  return remainingGames(standing) * 3;
}

/**
 * Evaluate motivation for a single team given the full league standings.
 *
 * standings: map of teamName → standing row (from getLeagueStandings)
 * team: the team to evaluate
 */
export function evaluateMotivation(
  team: string,
  standings: Map<string, Standing>,
): MotivationResult {
  const s = standings.get(team);
  if (!s) {
    // No standings data — assume normal (don't penalise for missing data)
    return { flag: 'NORMAL', reason: 'No standings data', suppress: false };
  }

  const remaining = remainingGames(s);
  const maxGain = maxPointsGainable(s);

  // ── Season over: no games remaining ───────────────────────────────────
  if (remaining === 0) {
    return { flag: 'ALREADY_DONE', reason: 'Season complete, no games remaining', suppress: true };
  }

  // ── Already done: description from API explicitly says so ──────────────
  const desc = (s.description ?? '').toLowerCase();
  if (desc.includes('relegation') && maxGain === 0) {
    return { flag: 'ALREADY_DONE', reason: 'Relegated, season over', suppress: true };
  }
  if (maxGain === 0) {
    return { flag: 'ALREADY_DONE', reason: 'Position clinched, nothing at stake', suppress: true };
  }

  // ── Convert standings to sorted array for gap calculations ─────────────
  const table = [...standings.values()].sort((a, b) => b.points - a.points);
  const totalTeams = s.matchesTotal;

  // Zone boundaries (approximate — works for most European leagues)
  // Top 4 = Champions League, 5-6 = Europa/Conference, bottom 3 = relegation
  const relegationCutoff = totalTeams - 3; // rank ≤ this = safe, rank > = danger
  const europaCutoff = Math.min(6, Math.floor(totalTeams * 0.3));

  const currentRank = s.rank;
  const currentPts = s.points;

  // Points of the team just above/below the nearest boundary
  const teamJustAboveRelegation = table[relegationCutoff - 1]; // last safe spot
  const teamJustBelowEuropa     = table[europaCutoff];         // first non-Europe spot
  const teamAbove               = currentRank >= 2 ? table[currentRank - 2] : null;
  const teamBelow               = currentRank < totalTeams ? table[currentRank] : null;

  // ── Must-win: fighting relegation ──────────────────────────────────────
  if (currentRank > relegationCutoff) {
    const ptsNeededSafe = teamJustAboveRelegation
      ? teamJustAboveRelegation.points - currentPts + 1
      : 0;
    if (ptsNeededSafe > 0 && ptsNeededSafe <= maxGain) {
      return {
        flag: 'MUST_WIN',
        reason: `${remaining}g left, needs ${ptsNeededSafe}pts to escape relegation`,
        suppress: false,
      };
    }
    if (ptsNeededSafe > maxGain) {
      return { flag: 'ALREADY_DONE', reason: 'Mathematically relegated', suppress: true };
    }
  }

  // ── Must-win: chasing title or Europe with tight margin ────────────────
  if (currentRank <= europaCutoff) {
    const ptsAhead = teamAbove ? currentPts - teamAbove.points : 999;
    // If they can still be displaced, flag as MUST_WIN only in final stretch
    if (remaining <= 5 && ptsAhead <= remaining * 3) {
      return {
        flag: 'MUST_WIN',
        reason: `Top-${europaCutoff} race, ${remaining}g left`,
        suppress: false,
      };
    }
  }

  // ── Locked in: mid-table, cannot move to any meaningful zone ───────────
  const safe = currentRank <= relegationCutoff;
  const inEurope = currentRank <= europaCutoff;

  if (safe && !inEurope) {
    // Can they still reach European spots?
    const ptsToEuropa = teamJustBelowEuropa
      ? teamJustBelowEuropa.points - currentPts
      : 999;
    // Can they still be relegated?
    const ptsAboveRelegation = teamJustAboveRelegation
      ? currentPts - teamJustAboveRelegation.points
      : 999;

    const canReachEuropa  = ptsToEuropa <= maxGain;
    const canBeRelegated  = ptsAboveRelegation <= maxGain;

    if (!canReachEuropa && !canBeRelegated) {
      return {
        flag: 'LOCKED_IN',
        reason: `Rank ${currentRank}/${totalTeams}, mid-table — position cannot change`,
        suppress: true,
      };
    }
  }

  // ── Locked in: European spot clinched AND cannot move up (title race over) ──
  // Only suppress if the team cannot gain OR lose their exact rank (truly locked in)
  if (inEurope && remaining > 0 && currentRank > 1) {
    const ptsToLoseEuropa = teamJustBelowEuropa
      ? currentPts - teamJustBelowEuropa.points
      : 999;
    const ptsToGainRank = teamAbove
      ? teamAbove.points - currentPts + 1
      : 999;
    const canLoseEuropa  = ptsToLoseEuropa <= maxGain;
    const canImproveRank = ptsToGainRank   <= maxGain;
    // Only suppress when locked into exact same spot — can neither rise nor fall out of Europe
    if (!canLoseEuropa && !canImproveRank) {
      return {
        flag: 'ALREADY_DONE',
        reason: `European spot locked in, rank cannot change`,
        suppress: true,
      };
    }
  }

  // ── Normal: position still meaningful ─────────────────────────────────
  return {
    flag: 'NORMAL',
    reason: `Rank ${currentRank}/${totalTeams}, ${remaining}g left`,
    suppress: false,
  };
}

/**
 * Evaluate motivation for both teams in a match.
 * Returns suppress=true if EITHER team is locked in (unreliable match dynamics).
 */
export function evaluateMatchMotivation(
  homeTeam: string,
  awayTeam: string,
  standings: Map<string, Standing>,
): { home: MotivationResult; away: MotivationResult; suppress: boolean; reason: string } {
  const home = evaluateMotivation(homeTeam, standings);
  const away = evaluateMotivation(awayTeam, standings);

  // Suppress if EITHER team has nothing/everything to play for
  const suppress = home.suppress || away.suppress;
  const reasons: string[] = [];
  if (home.suppress) reasons.push(`${homeTeam}: ${home.reason}`);
  if (away.suppress) reasons.push(`${awayTeam}: ${away.reason}`);

  return {
    home,
    away,
    suppress,
    reason: reasons.join(' | ') || 'Both teams have stakes',
  };
}
