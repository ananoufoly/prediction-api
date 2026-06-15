import { prisma } from '../db.js';
import { env } from '../env.js';
import { checkBudget, recordRequest } from './budget.js';

const BASE = 'https://api.the-odds-api.com/v4';

const SPORT_KEY_BY_LEAGUE: Record<string, string> = {
  'EPL': 'soccer_epl',
  'La Liga': 'soccer_spain_la_liga',
  'Bundesliga': 'soccer_germany_bundesliga',
  'Serie A': 'soccer_italy_serie_a',
  'Ligue 1': 'soccer_france_ligue_one',
  'Champions League': 'soccer_uefa_champs_league',
};

/**
 * Runs every minute. Finds matches kicking off in 4–6 minutes that have
 * at least one active (PAPER or PLACED) selection, then fetches a closing
 * odds snapshot for those specific events and marks it isClosing=true.
 */
export async function captureClosingSnapshots(): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.getTime() + 4 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 6 * 60 * 1000);

  // Find matches in the T-5min window that have active selections
  const matches = await prisma.match.findMany({
    where: {
      kickoffUtc: { gte: windowStart, lte: windowEnd },
      status: 'SCHEDULED',
      selections: {
        some: { status: { in: ['PAPER', 'PLACED'] } },
      },
    },
    include: { selections: { where: { status: { in: ['PAPER', 'PLACED'] } } } },
  });

  if (matches.length === 0) return;

  console.log(`[closing] T-5min window: ${matches.length} match(es) need closing snapshot`);

  if (!env.ODDS_API_KEY) {
    console.warn('[closing] No ODDS_API_KEY — cannot fetch closing odds');
    return;
  }

  await checkBudget('odds-api');

  for (const match of matches) {
    const sportKey = SPORT_KEY_BY_LEAGUE[match.league];
    if (!sportKey) {
      console.warn(`[closing] No sport key for league: ${match.league}`);
      continue;
    }

    try {
      // Fetch odds specifically for this event's sport
      const url = `${BASE}/sports/${sportKey}/odds/?apiKey=${env.ODDS_API_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal&bookmakers=pinnacle`;
      const res = await fetch(url);

      if (!res.ok) {
        console.error(`[closing] Odds API error ${res.status} for ${match.homeTeam} vs ${match.awayTeam}`);
        continue;
      }

      await recordRequest('odds-api', 1);

      interface ApiEvent {
        commence_time: string;
        home_team: string;
        away_team: string;
        bookmakers?: Array<{
          key: string;
          markets: Array<{
            key: string;
            outcomes: Array<{ name: string; price: number }>;
          }>;
        }>;
      }

      const events = (await res.json()) as ApiEvent[];
      const kickoffMs = match.kickoffUtc.getTime();

      // Match the specific event by teams + kickoff proximity (±10 min)
      const event = events.find((e) => {
        const diff = Math.abs(new Date(e.commence_time).getTime() - kickoffMs);
        return (
          diff < 10 * 60 * 1000 &&
          e.home_team.toLowerCase().includes(match.homeTeam.toLowerCase().split(' ')[0] ?? '') &&
          e.away_team.toLowerCase().includes(match.awayTeam.toLowerCase().split(' ')[0] ?? '')
        );
      });

      if (!event) {
        console.warn(`[closing] No Odds API event found for ${match.homeTeam} vs ${match.awayTeam}`);
        continue;
      }

      const fetchedAt = new Date();
      let snapshotCount = 0;

      for (const bookmaker of event.bookmakers ?? []) {
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
                isClosing: true,
              },
            });
            snapshotCount++;
          }
        }
      }

      console.log(`[closing] ${match.homeTeam} vs ${match.awayTeam} — ${snapshotCount} closing snapshots saved`);
    } catch (err) {
      console.error(`[closing] Failed for ${match.homeTeam} vs ${match.awayTeam}:`, err);
    }
  }
}
