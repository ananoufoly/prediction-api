import { prisma } from '../db.js';

/**
 * Elo ratings as a prior for teams with insufficient data (< MIN_GAMES_FOR_RATING).
 *
 * We compute Elo from historical results and use it to estimate attack/defense
 * ratings for promoted or new teams, rather than defaulting to exactly 1.0.
 *
 * Elo → xG proxy:
 *   attackRating  = exp((elo - leagueAvgElo) / ELO_SCALE * ATK_SENSITIVITY)
 *   defenseRating = exp(-(elo - leagueAvgElo) / ELO_SCALE * DEF_SENSITIVITY)
 *
 * This gives:
 *   - League average team → attack = 1.0, defense = 1.0
 *   - Strong team → attack > 1, defense < 1
 *   - Weak team → attack < 1, defense > 1
 */

const DEFAULT_ELO = 1500;
const K_FACTOR = 32;
const ELO_SCALE = 400;
const ATK_SENSITIVITY = 0.6;
const DEF_SENSITIVITY = 0.4;
const MIN_GAMES_FOR_RATING = 5;

export interface EloRating {
  team: string;
  elo: number;
  games: number;
}

export async function computeEloRatings(league: string): Promise<Map<string, EloRating>> {
  const matches = await prisma.match.findMany({
    where: {
      league,
      status: 'FINAL',
      homeGoals: { not: null },
      awayGoals: { not: null },
    },
    orderBy: { kickoffUtc: 'asc' },
  });

  const ratings = new Map<string, EloRating>();

  const get = (team: string): EloRating => {
    if (!ratings.has(team)) ratings.set(team, { team, elo: DEFAULT_ELO, games: 0 });
    return ratings.get(team)!;
  };

  for (const m of matches) {
    const home = get(m.homeTeam);
    const away = get(m.awayTeam);
    const hg = m.homeGoals!;
    const ag = m.awayGoals!;

    // Actual score: 1 = home win, 0.5 = draw, 0 = away win
    const score = hg > ag ? 1 : hg === ag ? 0.5 : 0;

    // Expected score (with home advantage ~100 Elo points)
    const eloAdv = 100;
    const eHome = 1 / (1 + Math.pow(10, (away.elo - home.elo - eloAdv) / ELO_SCALE));
    const eAway = 1 - eHome;

    home.elo = home.elo + K_FACTOR * (score - eHome);
    away.elo = away.elo + K_FACTOR * ((1 - score) - eAway);
    home.games++;
    away.games++;
  }

  return ratings;
}

/**
 * Convert Elo rating to attack/defense proxy for teams with < MIN_GAMES_FOR_RATING.
 * For established teams the actual xG rating takes precedence.
 */
export function eloToRatingProxy(
  teamElo: number,
  leagueAvgElo: number,
): { attack: number; defense: number } {
  const delta = (teamElo - leagueAvgElo) / ELO_SCALE;
  return {
    attack: Math.exp(delta * ATK_SENSITIVITY),
    defense: Math.exp(-delta * DEF_SENSITIVITY),
  };
}

/**
 * Enrich xG ratings map with Elo-based priors for low-data teams.
 */
export async function applyEloPriors(
  league: string,
  teams: Map<string, { team: string; attack: number; defense: number; games: number }>,
): Promise<void> {
  const eloRatings = await computeEloRatings(league);
  if (eloRatings.size === 0) return;

  const avgElo =
    [...eloRatings.values()].reduce((s, r) => s + r.elo, 0) / eloRatings.size;

  let applied = 0;
  for (const [team, xgRating] of teams) {
    if (xgRating.games >= MIN_GAMES_FOR_RATING) continue;

    const eloRating = eloRatings.get(team);
    if (!eloRating) continue;

    const proxy = eloToRatingProxy(eloRating.elo, avgElo);
    teams.set(team, { team, attack: proxy.attack, defense: proxy.defense, games: xgRating.games });
    applied++;
  }

  if (applied > 0) {
    console.log(`[elo] ${league}: applied Elo priors for ${applied} low-data teams`);
  }
}
