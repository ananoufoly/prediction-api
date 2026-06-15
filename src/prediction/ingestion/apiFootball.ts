import { prisma } from '../../db.js';
import { withRunLog } from '../util/runLog.js';
import {
  checkProviderBudget,
  recordProviderRequest,
  remainingProviderBudget,
} from '../util/budget.js';

/**
 * API-Football (v3) ingestion for the prediction engine.
 *
 * FREE-PLAN LIMITATIONS (confirmed live 2026-06-15):
 *   - Seasons 2022–2024 only (no current 2025-26 season, no pre-2022).
 *   - `next` / `last` parameters are blocked — must query whole seasons.
 *   - 100 requests/DAY hard cap.
 *
 * Consequence: lineups + injuries are 1 request PER FIXTURE, so a full season
 * (380 fixtures × 2) cannot be pulled in a day. We therefore:
 *   1. Pull whole-season fixtures (1 req/league/season) into football_fixtures.
 *   2. Enrich lineups/injuries incrementally, bounded by the daily budget,
 *      prioritising fixtures that have no lineup rows yet.
 */

const PROVIDER = 'api_football';
const BASE = 'https://v3.football.api-sports.io';

// API-Football league ids → our league names. Seasons available on Free: 2022–2024.
const LEAGUES: Array<{ id: number; name: string }> = [
  { id: 39, name: 'EPL' },
  { id: 140, name: 'La Liga' },
  { id: 78, name: 'Bundesliga' },
  { id: 135, name: 'Serie A' },
  { id: 61, name: 'Ligue 1' },
];

const FREE_SEASONS = [2022, 2023, 2024];

// How many fixtures to enrich with lineups+injuries per run (×2 requests each).
// Kept well under the 100/day cap to leave headroom for fixtures pulls.
const ENRICH_BATCH = 20;

function apiKey(): string {
  const key = process.env['API_FOOTBALL_KEY'];
  if (!key) throw new Error('API_FOOTBALL_KEY is not set');
  return key;
}

interface AfResponse<T> {
  errors: unknown;
  results: number;
  response: T[];
}

// Free plan allows ~10 req/min. Space requests ~7s apart to stay well under it.
const MIN_REQUEST_GAP_MS = 7000;
let lastRequestAt = 0;

async function afGet<T>(path: string): Promise<AfResponse<T>> {
  await checkProviderBudget(PROVIDER);
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-apisports-key': apiKey() },
  });
  await recordProviderRequest(PROVIDER);
  if (res.status === 429) {
    throw new Error(`API-Football ${path}: HTTP 429 (rate limit) — will retry next run`);
  }
  if (!res.ok) throw new Error(`API-Football ${path}: HTTP ${res.status}`);
  const data = (await res.json()) as AfResponse<T>;
  // API-Football returns 200 with an `errors` object/array on plan/param issues.
  const errs = data.errors;
  const hasErr = Array.isArray(errs) ? errs.length > 0 : errs && Object.keys(errs).length > 0;
  if (hasErr) throw new Error(`API-Football ${path}: ${JSON.stringify(errs)}`);
  return data;
}

interface AfFixture {
  fixture: { id: number; date: string; status: { short: string } };
  teams: { home: { name: string }; away: { name: string } };
  goals: { home: number | null; away: number | null };
}

function mapStatus(short: string): string {
  if (['FT', 'AET', 'PEN'].includes(short)) return 'FINAL';
  if (['PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(short)) return 'POSTPONED';
  return 'SCHEDULED';
}

/** Pull whole-season fixtures for one league/season (1 request). */
async function ingestSeasonFixtures(
  leagueId: number,
  leagueName: string,
  season: number,
  addRows: (n: number) => void,
): Promise<void> {
  const data = await afGet<AfFixture>(`/fixtures?league=${leagueId}&season=${season}`);
  for (const f of data.response) {
    const status = mapStatus(f.fixture.status.short);
    const isFinal = status === 'FINAL';
    await prisma.footballFixture.upsert({
      where: {
        source_sourceMatchId: { source: PROVIDER, sourceMatchId: String(f.fixture.id) },
      },
      create: {
        source: PROVIDER,
        sourceMatchId: String(f.fixture.id),
        league: leagueName,
        season,
        kickoffUtc: new Date(f.fixture.date),
        homeTeam: f.teams.home.name,
        awayTeam: f.teams.away.name,
        status,
        homeGoals: isFinal ? f.goals.home : null,
        awayGoals: isFinal ? f.goals.away : null,
      },
      update: {
        status,
        ...(isFinal ? { homeGoals: f.goals.home, awayGoals: f.goals.away } : {}),
      },
    });
    addRows(1);
  }
}

interface AfLineup {
  team: { name: string };
  formation: string | null;
  startXI: Array<{ player: { id: number; name: string; pos: string | null } }>;
  substitutes: Array<{ player: { id: number; name: string; pos: string | null } }>;
}

interface AfInjury {
  player: { id: number; name: string; type: string | null; reason: string | null };
  team: { name: string };
}

/** Enrich one fixture with lineups + injuries (2 requests). */
async function enrichFixture(
  fixtureRowId: string,
  apiFixtureId: string,
  addRows: (n: number) => void,
): Promise<void> {
  const lineups = await afGet<AfLineup>(`/fixtures/lineups?fixture=${apiFixtureId}`);
  for (const lu of lineups.response) {
    const rows: Array<{ name: string; id: number; role: string; pos: string | null }> = [
      ...lu.startXI.map((p) => ({ name: p.player.name, id: p.player.id, role: 'STARTER', pos: p.player.pos })),
      ...lu.substitutes.map((p) => ({ name: p.player.name, id: p.player.id, role: 'SUB', pos: p.player.pos })),
    ];
    for (const r of rows) {
      await prisma.footballLineup.upsert({
        where: {
          fixtureId_team_playerName_role: {
            fixtureId: fixtureRowId,
            team: lu.team.name,
            playerName: r.name,
            role: r.role,
          },
        },
        create: {
          fixtureId: fixtureRowId,
          apiFixtureId,
          team: lu.team.name,
          playerName: r.name,
          playerId: r.id,
          role: r.role,
          position: r.pos,
        },
        update: { playerId: r.id, position: r.pos },
      });
      addRows(1);
    }
  }

  const injuries = await afGet<AfInjury>(`/injuries?fixture=${apiFixtureId}`);
  for (const inj of injuries.response) {
    // "Missing Fixture" with a suspension reason → SUSPENDED, else INJURED.
    const reason = inj.player.reason ?? '';
    const role = /suspend/i.test(reason) ? 'SUSPENDED' : 'INJURED';
    await prisma.footballLineup.upsert({
      where: {
        fixtureId_team_playerName_role: {
          fixtureId: fixtureRowId,
          team: inj.team.name,
          playerName: inj.player.name,
          role,
        },
      },
      create: {
        fixtureId: fixtureRowId,
        apiFixtureId,
        team: inj.team.name,
        playerName: inj.player.name,
        playerId: inj.player.id,
        role,
        reason: inj.player.reason,
      },
      update: { reason: inj.player.reason },
    });
    addRows(1);
  }
}

/**
 * Main entry. Pulls season fixtures for any (league, season) not yet stored,
 * then spends remaining daily budget enriching fixtures that lack lineups.
 */
export async function ingestApiFootball(opts?: {
  seasons?: number[];
  enrichBatch?: number;
}): Promise<void> {
  const seasons = opts?.seasons ?? FREE_SEASONS;
  const enrichBatch = opts?.enrichBatch ?? ENRICH_BATCH;

  await withRunLog('football', PROVIDER, async ({ addRows, note }) => {
    // --- Phase A: fixtures (1 req per league/season, only if not already present) ---
    for (const season of seasons) {
      for (const lg of LEAGUES) {
        const remaining = await remainingProviderBudget(PROVIDER);
        if (remaining <= enrichBatch * 2 + 1) {
          note(`budget low (${remaining} left) — stopping before fixtures ${lg.name} ${season}`);
          break;
        }
        const have = await prisma.footballFixture.count({
          where: { source: PROVIDER, league: lg.name, season },
        });
        if (have > 0) continue; // already pulled this season; skip to save quota
        try {
          await ingestSeasonFixtures(lg.id, lg.name, season, addRows);
        } catch (err) {
          note(`fixtures ${lg.name} ${season} failed: ${(err as Error).message}`);
        }
      }
    }

    // --- Phase B: enrich fixtures lacking lineups, bounded by budget ---
    const remaining = await remainingProviderBudget(PROVIDER);
    const canEnrich = Math.min(enrichBatch, Math.floor(remaining / 2));
    if (canEnrich <= 0) {
      note(`no budget left for enrichment (${remaining} req remaining)`);
      return;
    }

    // Fixtures with zero lineup rows, most recent first.
    const candidates = await prisma.footballFixture.findMany({
      where: { source: PROVIDER, lineups: { none: {} } },
      orderBy: { kickoffUtc: 'desc' },
      take: canEnrich,
      select: { id: true, sourceMatchId: true },
    });

    let enriched = 0;
    for (const c of candidates) {
      try {
        await enrichFixture(c.id, c.sourceMatchId, addRows);
        enriched++;
      } catch (err) {
        note(`enrich ${c.sourceMatchId} failed: ${(err as Error).message}`);
        // Budget exhaustion throws — stop the loop.
        if (/Budget exhausted/.test((err as Error).message)) break;
      }
    }
    note(`enriched ${enriched}/${candidates.length} fixtures`);
  });
}
