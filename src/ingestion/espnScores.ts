import { prisma } from '../db.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

// ESPN league slugs
const ESPN_LEAGUES: Record<string, string> = {
  'EPL': 'eng.1',
  'La Liga': 'esp.1',
  'Bundesliga': 'ger.1',
  'Serie A': 'ita.1',
  'Ligue 1': 'fra.1',
  'Champions League': 'UEFA.CHAMPIONS',
  'Eredivisie': 'ned.1',
  'Liga Portugal': 'por.1',
  'MLS': 'usa.1',
  'Süper Lig': 'tur.1',
  'J League': 'jpn.1',
  'Europa League': 'UEFA.EUROPA',
};

interface EspnEvent {
  id: string;
  date: string;
  status: { type: { name: string; completed: boolean; state: string }; displayClock?: string; period?: number };
  competitions: EspnCompetition[];
}

interface EspnCompetition {
  competitors: EspnCompetitor[];
}

interface EspnCompetitor {
  homeAway: 'home' | 'away';
  team: { displayName: string; shortDisplayName: string };
  score: string;
}

function mapStatus(espnState: string, completed: boolean): 'SCHEDULED' | 'LIVE' | 'FINAL' {
  if (completed) return 'FINAL';
  if (espnState === 'in') return 'LIVE';
  return 'SCHEDULED';
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

export async function fetchEspnScores(league: string): Promise<void> {
  const slug = ESPN_LEAGUES[league];
  if (!slug) return;

  // Fetch current week + next 14 days to populate upcoming fixtures
  const dates: string[] = [yyyymmdd(new Date())];
  for (let i = 7; i <= 14; i += 7) {
    dates.push(yyyymmdd(new Date(Date.now() + i * 86_400_000)));
  }

  const allEvents: EspnEvent[] = [];
  for (const date of dates) {
    const url = `${BASE}/${slug}/scoreboard?dates=${date}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json() as { events?: EspnEvent[] };
    allEvents.push(...(data.events ?? []));
  }

  // Dedup by event id
  const seen = new Set<string>();
  const events = allEvents.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  let upserted = 0;
  for (const event of events) {
    const comp = event.competitions[0];
    if (!comp) continue;

    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;

    const kickoffUtc = new Date(event.date);
    const status = mapStatus(event.status.type.state, event.status.type.completed);
    // Capture score for LIVE and FINAL matches
    const scoreAvailable = status === 'LIVE' || status === 'FINAL';
    const homeGoalsParsed = scoreAvailable ? parseInt(home.score, 10) : NaN;
    const awayGoalsParsed = scoreAvailable ? parseInt(away.score, 10) : NaN;
    const homeGoals = !isNaN(homeGoalsParsed) ? homeGoalsParsed : null;
    const awayGoals = !isNaN(awayGoalsParsed) ? awayGoalsParsed : null;

    // Parse elapsed minutes from ESPN displayClock (e.g. "85'" or "45+2'")
    let elapsedMinutes: number | null = null;
    if (status === 'LIVE') {
      const clock = event.status.displayClock ?? '';
      const base = parseInt(clock, 10);
      const stoppage = parseInt((clock.match(/\+(\d+)/) ?? [])[1] ?? '0', 10);
      if (!isNaN(base)) elapsedMinutes = base + stoppage;
    } else if (status === 'FINAL') {
      elapsedMinutes = 90;
    }

    await prisma.match.upsert({
      where: {
        league_homeTeam_awayTeam_kickoffUtc: {
          league,
          homeTeam: home.team.displayName,
          awayTeam: away.team.displayName,
          kickoffUtc,
        },
      },
      create: {
        league,
        homeTeam: home.team.displayName,
        awayTeam: away.team.displayName,
        kickoffUtc,
        status,
        homeGoals,
        awayGoals,
        ...(elapsedMinutes !== null ? { elapsedMinutes } : {}),
      },
      update: {
        status,
        ...(homeGoals !== null ? { homeGoals, awayGoals } : {}),
        ...(elapsedMinutes !== null ? { elapsedMinutes } : {}),
      },
    });
    upserted++;
  }

  console.log(`[espn] ${league} — upserted ${upserted} events`);
}

export async function fetchAllEspnScores(): Promise<void> {
  for (const league of Object.keys(ESPN_LEAGUES)) {
    try {
      await fetchEspnScores(league);
    } catch (err) {
      console.error(`[espn] Failed for ${league}:`, err);
    }
  }
}
