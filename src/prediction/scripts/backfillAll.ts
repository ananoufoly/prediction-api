import { prisma } from '../../db.js';
import { ingestApiFootball } from '../ingestion/apiFootball.js';
import { ingestOpenfootballHistory } from '../ingestion/openfootballHistory.js';
import { ingestTennisSackmann } from '../ingestion/tennisSackmann.js';
import { ingestRugby } from '../ingestion/rugbyEspn.js';
import { ingestNba } from '../ingestion/nba.js';
import { ingestNfl } from '../ingestion/nfl.js';
import { ingestMlb } from '../ingestion/mlb.js';

/**
 * One-shot full historical backfill for the prediction engine.
 *
 *   npx tsx --env-file=.env src/prediction/scripts/backfillAll.ts [sport ...]
 *
 * With no args, runs every sport. NOTE: API-Football is budget-gated (100/day)
 * so its lineup/injury enrichment will span multiple days of cron runs; the
 * one-shot only pulls what today's budget allows.
 */

const SPORTS: Record<string, () => Promise<void>> = {
  football: async () => {
    await ingestOpenfootballHistory(); // full history first (free)
    await ingestApiFootball();         // fixtures + bounded enrichment (budget-gated)
  },
  tennis: () => ingestTennisSackmann({ fromYear: 2000 }), // full ATP+WTA history
  rugby: () => ingestRugby(),
  nba: () => ingestNba(),
  nfl: () => ingestNfl(),
  mlb: () => ingestMlb(),
};

async function main() {
  const requested = process.argv.slice(2);
  const targets = requested.length ? requested : Object.keys(SPORTS);

  for (const sport of targets) {
    const fn = SPORTS[sport];
    if (!fn) {
      console.error(`[backfill] unknown sport "${sport}" — known: ${Object.keys(SPORTS).join(', ')}`);
      continue;
    }
    console.log(`\n[backfill] === ${sport} ===`);
    const t0 = Date.now();
    try {
      await fn();
      console.log(`[backfill] ${sport} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (err) {
      console.error(`[backfill] ${sport} FAILED:`, err);
    }
  }

  console.log('\n[backfill] row counts:');
  const counts = {
    football_fixtures: await prisma.footballFixture.count(),
    football_lineups: await prisma.footballLineup.count(),
    tennis_matches: await prisma.tennisMatch.count(),
    nba_game_logs: await prisma.nbaGameLog.count(),
    nfl_team_games: await prisma.nflTeamGame.count(),
    nfl_injuries: await prisma.nflInjury.count(),
    mlb_team_games: await prisma.mlbTeamGame.count(),
    mlb_pitcher_stats: await prisma.mlbPitcherStat.count(),
    rugby_matches: await prisma.rugbyMatch.count(),
    rugby_standings: await prisma.rugbyStanding.count(),
  };
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
