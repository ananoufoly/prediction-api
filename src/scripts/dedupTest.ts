import { prisma } from '../db.js';

async function main() {
  const match = await prisma.match.findFirst({ where: { status: 'SCHEDULED' }, orderBy: { kickoffUtc: 'asc' } });
  if (!match) { console.error('No scheduled match'); process.exit(1); }

  const candidate = {
    matchId: match.id,
    league: match.league,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    kickoffUtc: match.kickoffUtc,
    market: 'h2h',
    outcome: match.homeTeam,
    modelProb: 0.60,
    pinnacleFairProb: 0.59,
    bookieFairProb: 0.57,
    bookmaker: 'betfair',
    decimalOdds: 1.75,
    edgePct: 0.053,
    kellyFraction: 0.006,
    recommendedStake: 6.0,
    confidence: 'HIGH' as const,
    confidenceDetail: { reason: 'test', pinnaclePresent: true, regime: 'cold' },
  };

  const r1 = await fetch('http://localhost:3001/api/selections/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(candidate),
  }).then((r) => r.json()) as { ok: boolean; deduplicated: boolean; id?: string };
  console.log(`First save:  ok=${r1.ok} deduplicated=${r1.deduplicated}`);

  const r2 = await fetch('http://localhost:3001/api/selections/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(candidate),
  }).then((r) => r.json()) as { ok: boolean; deduplicated: boolean; id?: string };
  console.log(`Second save: ok=${r2.ok} deduplicated=${r2.deduplicated} ← should be true`);

  // Same match, different odds (line moved) — should create new row
  const r3 = await fetch('http://localhost:3001/api/selections/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...candidate, decimalOdds: 1.78 }),
  }).then((r) => r.json()) as { ok: boolean; deduplicated: boolean };
  console.log(`Third save (different odds 1.78): ok=${r3.ok} deduplicated=${r3.deduplicated} ← should be false`);

  const count = await prisma.selection.count({
    where: { matchId: match.id, market: 'h2h', bookmaker: 'betfair' },
  });
  console.log(`\nDB rows for this match+market+bookmaker: ${count} — expected 2 (1.75 and 1.78)`);

  // Cleanup
  await prisma.selection.deleteMany({
    where: { matchId: match.id, market: 'h2h', bookmaker: 'betfair' },
  });
  console.log('[✓] Dedup test complete — cleaned up');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
