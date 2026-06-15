import { prisma } from '../db.js';
import { env } from '../env.js';
import { checkBudget, recordRequest } from './budget.js';

const BASE = 'https://api.the-odds-api.com/v4';

// Leagues we care about mapped to Odds API sport keys
export const TRACKED_SPORTS: Record<string, string> = {
  // European top leagues (inactive Jun–Jul, back in Aug)
  'soccer_epl': 'EPL',
  'soccer_spain_la_liga': 'La Liga',
  'soccer_germany_bundesliga': 'Bundesliga',
  'soccer_italy_serie_a': 'Serie A',
  'soccer_france_ligue_one': 'Ligue 1',
  'soccer_netherlands_eredivisie': 'Eredivisie',
  'soccer_portugal_primeira_liga': 'Liga Portugal',
  'soccer_turkey_super_league': 'Süper Lig',
  // European cups (inactive Jun–Jul)
  'soccer_uefa_champs_league': 'Champions League',
  'soccer_uefa_europa_league': 'Europa League',
  'soccer_germany_dfb_pokal': 'DFB-Pokal',
  // Year-round leagues
  'soccer_usa_mls': 'MLS',
  'soccer_japan_j_league': 'J League',
  'soccer_korea_kleague1': 'K League 1',
  // Summer 2026 tournaments
  'soccer_fifa_world_cup': 'FIFA World Cup',
  'soccer_conmebol_copa_libertadores': 'Copa Libertadores',
  'soccer_conmebol_copa_sudamericana': 'Copa Sudamericana',
};

interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: OddsApiBookmaker[];
}

interface OddsApiBookmaker {
  key: string;
  markets: OddsApiMarket[];
}

interface OddsApiMarket {
  key: string;
  last_update: string;
  outcomes: { name: string; price: number }[];
}

export async function fetchOddsForSport(sportKey: string): Promise<void> {
  const keys: { key: string; bucket: string }[] = [];
  if (env.ODDS_API_KEY) keys.push({ key: env.ODDS_API_KEY, bucket: 'odds-api' });
  if (env.ODDS_API_KEY_2) keys.push({ key: env.ODDS_API_KEY_2, bucket: 'odds-api-2' });
  if (env.ODDS_API_KEY_3) keys.push({ key: env.ODDS_API_KEY_3, bucket: 'odds-api-3' });
  if (keys.length === 0) throw new Error('No ODDS_API_KEY configured');

  let lastErr: unknown;
  for (const { key, bucket } of keys) {
    try {
      await checkBudget(bucket);
    } catch {
      continue;
    }

    const url = `${BASE}/sports/${sportKey}/odds/?apiKey=${key}&regions=eu&markets=h2h,totals&oddsFormat=decimal&bookmakers=pinnacle,bet365,unibet`;
    const res = await fetch(url);

    if (!res.ok) {
      lastErr = new Error(`Odds API error (${bucket}): ${res.status} ${await res.text()}`);
      continue;
    }

    const remaining = res.headers.get('x-requests-remaining');
    const used = res.headers.get('x-requests-used');
    await recordRequest(bucket, 1);
    console.log(`[odds-api] ${sportKey} (${bucket}) — used: ${used}, remaining: ${remaining}`);

    const events = (await res.json()) as OddsApiEvent[];
    await upsertOddsEvents(events, sportKey);
    return;
  }

  throw lastErr ?? new Error('All Odds API keys budget-exhausted');
}

async function upsertOddsEvents(events: OddsApiEvent[], sportKey: string): Promise<void> {
  const league = TRACKED_SPORTS[sportKey] ?? sportKey;

  for (const event of events) {
    const kickoffUtc = new Date(event.commence_time);

    // Upsert match (idempotent by league+teams+kickoff)
    const match = await prisma.match.upsert({
      where: {
        league_homeTeam_awayTeam_kickoffUtc: {
          league,
          homeTeam: event.home_team,
          awayTeam: event.away_team,
          kickoffUtc,
        },
      },
      create: {
        league,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        kickoffUtc,
        status: 'SCHEDULED',
      },
      update: {},
    });

    if (!event.bookmakers) continue;

    const fetchedAt = new Date();

    for (const bookmaker of event.bookmakers) {
      for (const market of bookmaker.markets) {
        for (const outcome of market.outcomes) {
          await prisma.oddsSnapshot.create({
            data: {
              matchId: match.id,
              bookmaker: bookmaker.key,
              market: market.key,
              outcome: outcome.name,
              decimalOdds: outcome.price,
              fetchedAt,
              isClosing: false,
            },
          });
        }
      }
    }
  }
}

export async function fetchAllSports(): Promise<void> {
  for (const sportKey of Object.keys(TRACKED_SPORTS)) {
    try {
      await fetchOddsForSport(sportKey);
    } catch (err) {
      console.error(`[odds-api] Failed for ${sportKey}:`, err);
    }
  }
}
