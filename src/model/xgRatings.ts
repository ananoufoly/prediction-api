import { prisma } from '../db.js';
import { normalizeTeam } from '../ingestion/teamNorm.js';

export interface TeamRating {
  team: string;
  attack: number;
  defense: number;
  games: number;
}

export interface LeagueRatings {
  league: string;
  leagueAvgAttack: number;
  leagueAvgDefense: number;
  /** Rescales λ so model mean total goals matches empirical mean. Fitted from historical data. */
  goalConversionFactor: number;
  teams: Map<string, TeamRating>;
}

const HALF_LIFE_DAYS = 180;
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_DAYS;
const MIN_GAMES_FOR_RATING = 5;

function decayWeight(matchDate: Date, referenceDate: Date): number {
  const ageDays = (referenceDate.getTime() - matchDate.getTime()) / 86_400_000;
  return Math.exp(-DECAY_LAMBDA * Math.max(0, ageDays));
}

/**
 * Compute xG-based attack/defense ratings per team per league.
 *
 * Uses goals (falling back to xG when available) with exponential time decay.
 * Ratings are relative to league average (league avg = 1.0).
 *
 * Rating interpretation:
 *   attack  > 1.0 → scores more than league average
 *   defense < 1.0 → concedes less than league average (better defense)
 */
export async function computeXgRatings(
  league: string,
  referenceDate = new Date(),
): Promise<LeagueRatings> {
  const matches = await prisma.match.findMany({
    where: {
      league,
      status: 'FINAL',
      homeGoals: { not: null },
      awayGoals: { not: null },
    },
    orderBy: { kickoffUtc: 'asc' },
  });

  if (matches.length === 0) {
    return { league, leagueAvgAttack: 1, leagueAvgDefense: 1, goalConversionFactor: 1, teams: new Map() };
  }

  // Accumulate weighted goals/xG
  const teamStats = new Map<string, {
    weightedGoalsFor: number;
    weightedGoalsAgainst: number;
    weightedXgFor: number;
    weightedXgAgainst: number;
    totalWeight: number;
    games: number;
  }>();

  const ensure = (team: string) => {
    if (!teamStats.has(team)) {
      teamStats.set(team, {
        weightedGoalsFor: 0, weightedGoalsAgainst: 0,
        weightedXgFor: 0, weightedXgAgainst: 0,
        totalWeight: 0, games: 0,
      });
    }
    return teamStats.get(team)!;
  };

  for (const m of matches) {
    const w = decayWeight(m.kickoffUtc, referenceDate);
    const hGoals = m.homeGoals!;
    const aGoals = m.awayGoals!;
    // Use xG if available, else fall back to goals
    const hXg = m.homeXg ?? hGoals;
    const aXg = m.awayXg ?? aGoals;

    const home = ensure(m.homeTeam);
    home.weightedGoalsFor += w * hGoals;
    home.weightedGoalsAgainst += w * aGoals;
    home.weightedXgFor += w * hXg;
    home.weightedXgAgainst += w * aXg;
    home.totalWeight += w;
    home.games++;

    const away = ensure(m.awayTeam);
    away.weightedGoalsFor += w * aGoals;
    away.weightedGoalsAgainst += w * hGoals;
    away.weightedXgFor += w * aXg;
    away.weightedXgAgainst += w * hXg;
    away.totalWeight += w;
    away.games++;
  }

  // Compute raw weighted averages per team (goals/game)
  const rawRatings = new Map<string, { attack: number; defense: number; games: number }>();
  for (const [team, s] of teamStats) {
    if (s.totalWeight === 0) continue;
    // Prefer xG when available (>0 xG data means at least one match had xG)
    const hasXg = s.weightedXgFor > 0 && s.weightedXgFor !== s.weightedGoalsFor;
    const attack = hasXg
      ? s.weightedXgFor / s.totalWeight
      : s.weightedGoalsFor / s.totalWeight;
    const defense = hasXg
      ? s.weightedXgAgainst / s.totalWeight
      : s.weightedGoalsAgainst / s.totalWeight;
    rawRatings.set(team, { attack, defense, games: s.games });
  }

  // League average (unweighted across teams)
  const allAttacks = [...rawRatings.values()].map((r) => r.attack);
  const allDefenses = [...rawRatings.values()].map((r) => r.defense);
  const leagueAvgAttack = allAttacks.reduce((a, b) => a + b, 0) / allAttacks.length;
  const leagueAvgDefense = allDefenses.reduce((a, b) => a + b, 0) / allDefenses.length;

  // Normalize: rating = raw / leagueAvg (so league avg team = 1.0)
  // Teams below MIN_GAMES_FOR_RATING get league-average ratings (1.0)
  const teams = new Map<string, TeamRating>();
  for (const [team, r] of rawRatings) {
    if (r.games < MIN_GAMES_FOR_RATING) {
      teams.set(team, { team, attack: 1.0, defense: 1.0, games: r.games });
    } else {
      teams.set(team, {
        team,
        attack: r.attack / leagueAvgAttack,
        defense: r.defense / leagueAvgDefense,
        games: r.games,
      });
    }
  }

  // Compute goalConversionFactor: ratio of empirical avg goals/match to model-predicted avg.
  // Corrects for rating-interaction inflation (quadratic cross-product of attack × defense skews
  // predicted λ above the league mean when the distribution of ratings is non-uniform).
  const HOME_ADV = 1.25;
  let sumModelLambda = 0, nLambda = 0;
  const empiricalAvgGoals =
    matches.reduce((s, m) => s + m.homeGoals! + m.awayGoals!, 0) / matches.length;

  for (const m of matches) {
    const home = teams.get(m.homeTeam);
    const away = teams.get(m.awayTeam);
    if (!home || !away) continue;
    const lh = leagueAvgAttack * home.attack * away.defense * HOME_ADV;
    const la = leagueAvgAttack * away.attack * home.defense;
    sumModelLambda += lh + la;
    nLambda++;
  }

  const modelAvgLambda = nLambda > 0 ? sumModelLambda / nLambda : leagueAvgAttack * (1 + HOME_ADV);
  const goalConversionFactor = nLambda > 0 ? empiricalAvgGoals / modelAvgLambda : 1.0;

  if (Math.abs(goalConversionFactor - 1.0) > 0.05) {
    console.log(
      `[ratings] ${league}: goalConversionFactor=${goalConversionFactor.toFixed(3)} ` +
      `(model avg λ=${modelAvgLambda.toFixed(3)}, empirical avg=${empiricalAvgGoals.toFixed(3)})`,
    );
  }

  // Also index each rating under its normalized name so Odds API names resolve.
  // If the normalized name already exists, keep whichever has more games (more data = better rating).
  for (const [rawName, rating] of [...teams]) {
    const norm = normalizeTeam(rawName);
    if (norm === rawName) continue;
    const existing = teams.get(norm);
    if (!existing || rating.games > existing.games) {
      teams.set(norm, rating);
    }
  }

  return { league, leagueAvgAttack, leagueAvgDefense, goalConversionFactor, teams };
}

export async function computeAllLeagueRatings(): Promise<Map<string, LeagueRatings>> {
  const leagues = await prisma.match.findMany({
    where: { status: 'FINAL' },
    select: { league: true },
    distinct: ['league'],
  });

  const result = new Map<string, LeagueRatings>();
  for (const { league } of leagues) {
    result.set(league, await computeXgRatings(league));
  }
  return result;
}
