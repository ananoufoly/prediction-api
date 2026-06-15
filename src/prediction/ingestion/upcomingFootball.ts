import { prisma } from '../../db.js';
import { normalizeTeam } from '../../ingestion/teamNorm.js';
import { withRunLog } from '../util/runLog.js';

/**
 * Upcoming football fixtures from ESPN scoreboards (free, no key).
 *
 * This is the "what's coming up" feed for the prediction engine: we DON'T need
 * odds — only the fixture list (who plays whom, when). The trained models then
 * run on these fixtures. ESPN exposes a forward window (group + knockout weeks
 * out for tournaments; the upcoming round for leagues).
 *
 * Team names are normalised to match the training data so the Dixon-Coles model
 * can look up each side's attack/defence strength. Teams it never trained on
 * (e.g. World Cup national sides — the model knows club teams) will simply be
 * flagged unknown_team at prediction time, which is honest.
 *
 * Stored in football_fixtures with source='espn_upcoming', status='SCHEDULED'.
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const SOURCE = 'espn_upcoming';

// ESPN slug → our league name (must match historical league names for model coverage).
const LEAGUES: Array<{ slug: string; league: string; season: number }> = [
  { slug: 'eng.1', league: 'EPL', season: 2025 },
  { slug: 'esp.1', league: 'La Liga', season: 2025 },
  { slug: 'ger.1', league: 'Bundesliga', season: 2025 },
  { slug: 'ita.1', league: 'Serie A', season: 2025 },
  { slug: 'fra.1', league: 'Ligue 1', season: 2025 },
  // Tournaments — national teams; surfaced for visibility (model flags unknown_team).
  { slug: 'fifa.world', league: 'World Cup', season: 2026 },
];

interface EspnEvent {
  id: string;
  date: string;
  status: { type: { state: string; completed: boolean } };
  competitions: Array<{
    competitors: Array<{ homeAway: 'home' | 'away'; team: { displayName: string } }>;
  }>;
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export async function ingestUpcomingFootball(opts?: { forwardDays?: number }): Promise<void> {
  const forwardDays = opts?.forwardDays ?? 28;

  await withRunLog('football', SOURCE, async ({ addRows, note }) => {
    // Sweep today → +forwardDays at weekly offsets (ESPN returns ~a day/round per call).
    const offsets: number[] = [];
    for (let d = 0; d <= forwardDays; d += 1) offsets.push(d);

    for (const { slug, league, season } of LEAGUES) {
      const seen = new Set<string>();
      let written = 0;
      for (const off of offsets) {
        const date = yyyymmdd(new Date(Date.now() + off * 86_400_000));
        let data: { events?: EspnEvent[] };
        try {
          const res = await fetch(`${BASE}/${slug}/scoreboard?dates=${date}`);
          if (!res.ok) continue;
          data = (await res.json()) as { events?: EspnEvent[] };
        } catch {
          continue;
        }
        for (const ev of data.events ?? []) {
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          // Only future / not-yet-final fixtures.
          if (ev.status.type.completed) continue;
          const comp = ev.competitions[0];
          if (!comp) continue;
          const home = comp.competitors.find((c) => c.homeAway === 'home');
          const away = comp.competitors.find((c) => c.homeAway === 'away');
          if (!home || !away) continue;

          const kickoffUtc = new Date(ev.date);
          if (isNaN(kickoffUtc.getTime()) || kickoffUtc.getTime() < Date.now() - 6 * 3_600_000) continue;

          await prisma.footballFixture.upsert({
            where: { source_sourceMatchId: { source: SOURCE, sourceMatchId: ev.id } },
            create: {
              source: SOURCE,
              sourceMatchId: ev.id,
              league,
              season,
              kickoffUtc,
              homeTeam: normalizeTeam(home.team.displayName),
              awayTeam: normalizeTeam(away.team.displayName),
              status: 'SCHEDULED',
            },
            update: {
              kickoffUtc,
              status: 'SCHEDULED',
              homeTeam: normalizeTeam(home.team.displayName),
              awayTeam: normalizeTeam(away.team.displayName),
            },
          });
          addRows(1);
          written++;
        }
        // Be polite to ESPN.
        await new Promise((r) => setTimeout(r, 120));
      }
      note(`${league}: ${written} upcoming`);
    }
  });
}
