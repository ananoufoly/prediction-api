import { generateSelections } from '../selection/pipeline.js';
import { prisma } from '../db.js';

async function main() {
  // Try each league — we need at least one with upcoming fixtures + odds
  const leagues = ['EPL', 'La Liga', 'Bundesliga', 'Serie A'];

  for (const league of leagues) {
    const candidates = await generateSelections(league, 1000);
    if (candidates.length === 0) {
      console.log(`${league}: 0 candidates (no upcoming matches with fresh odds — expected without API key)`);
      continue;
    }

    console.log(`\n═══ ${league}: ${candidates.length} candidates ═══`);
    const sample = candidates.slice(0, 8);
    for (const c of sample) {
      console.log(
        `  ${c.homeTeam} vs ${c.awayTeam} | ${c.market}:${c.outcome}` +
        `\n    edge=${(c.edgePct * 100).toFixed(2)}%  model=${(c.modelProb * 100).toFixed(1)}%` +
        `  bookie=${(c.bookieFairProb * 100).toFixed(1)}%  odds=${c.decimalOdds}` +
        `\n    stake=€${c.recommendedStake.toFixed(2)}  confidence=${c.confidence}` +
        `\n    reason: ${c.confidenceDetail.reason}` +
        `\n    Pinnacle: ${c.confidenceDetail.pinnaclePresent ? 'present' : 'ABSENT'}`,
      );
    }

    // Distribution checks
    const edges = candidates.map((c) => c.edgePct * 100);
    const stakes = candidates.map((c) => c.recommendedStake);
    const confCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const c of candidates) confCounts[c.confidence]++;

    console.log(`\n  Edge distribution:`);
    console.log(`    0-5%: ${edges.filter((e) => e < 5).length}`);
    console.log(`    5-10%: ${edges.filter((e) => e >= 5 && e < 10).length}`);
    console.log(`    10-15%: ${edges.filter((e) => e >= 10 && e < 15).length}`);
    console.log(`    >15%: ${edges.filter((e) => e >= 15).length}  ← should be rare`);
    console.log(`  Stakes: min=€${Math.min(...stakes).toFixed(2)} max=€${Math.max(...stakes).toFixed(2)} (bankroll €1000)`);
    console.log(`  Confidence: HIGH=${confCounts.HIGH} MEDIUM=${confCounts.MEDIUM} LOW=${confCounts.LOW}`);
    console.log(`  Pinnacle absent: ${candidates.filter((c) => !c.confidenceDetail.pinnaclePresent).length}/${candidates.length}`);
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
