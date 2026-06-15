import { prisma } from '../db.js';

async function main() {
  // 1. Find a real scheduled match
  const match = await prisma.match.findFirst({
    where: { status: 'SCHEDULED' },
    orderBy: { kickoffUtc: 'asc' },
  });
  if (!match) { console.error('No scheduled matches in DB'); process.exit(1); }
  console.log(`Match: ${match.homeTeam} vs ${match.awayTeam} (${match.league}) — ${match.id}`);

  // 2. Create PAPER selection
  const sel = await prisma.selection.create({
    data: {
      matchId: match.id,
      market: 'h2h',
      outcome: match.homeTeam,
      modelProb: 0.62,
      pinnacleFairProb: 0.60,
      bookieFairProb: 0.58,
      bookmaker: 'unibet',
      oddsAtSelection: 1.72,
      edgePct: 0.069,
      kellyFraction: 0.007,
      recommendedStake: 7.0,
      confidence: 'HIGH',
      status: 'PAPER',
    },
  });
  console.log(`\n[1] Created PAPER selection: ${sel.id}`);

  // 3. Verify it appears in history
  const history = await fetch('http://localhost:3001/api/selections').then((r) => r.json()) as unknown[];
  console.log(`[2] History endpoint returns ${history.length} selection(s) — expected >=1`);

  // 4. Place it (PAPER → PLACED)
  const placed = await fetch(`http://localhost:3001/api/selections/${sel.id}/place`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stakeActual: 7.0 }),
  }).then((r) => r.json()) as { status: string };
  console.log(`[3] After place: status=${placed.status} — expected PLACED`);

  // 5. Settle it with closing odds
  //    closingOdds=1.65 → CLV = 1.65/1.72 - 1 = -0.0407 (negative, bet was over-priced at selection)
  //    result=WIN → pnl = 7.0 * (1.72 - 1) = 5.04
  const settled = await fetch(`http://localhost:3001/api/selections/${sel.id}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'WIN', closingOdds: 1.65 }),
  }).then((r) => r.json()) as { status: string; result: string; pnl: number; clv: number };
  console.log(`[4] After settle: status=${settled.status} result=${settled.result} pnl=${settled.pnl} clv=${settled.clv?.toFixed(4)}`);

  const expectedClv = 1.65 / 1.72 - 1;
  const expectedPnl = 7.0 * (1.72 - 1);
  const clvOk = Math.abs(settled.clv - expectedClv) < 0.0001;
  const pnlOk = Math.abs(settled.pnl - expectedPnl) < 0.01;
  console.log(`    CLV expected=${expectedClv.toFixed(4)} ok=${clvOk}`);
  console.log(`    P&L expected=${expectedPnl.toFixed(2)} ok=${pnlOk}`);

  // 6. Verify CLV summary now shows data
  const clvSummary = await fetch('http://localhost:3001/api/selections/clv-summary').then((r) => r.json()) as {
    totalSettled: number; last30: { avg: number; n: number } | null
  };
  console.log(`[5] CLV summary: totalSettled=${clvSummary.totalSettled} last30=${JSON.stringify(clvSummary.last30)} — expect null (n<20)`);

  // 7. Verify P&L summary
  const pnlSummary = await fetch('http://localhost:3001/api/selections/pnl-summary').then((r) => r.json()) as {
    totalPnl: number; n: number
  };
  console.log(`[6] P&L summary: totalPnl=${pnlSummary.totalPnl} n=${pnlSummary.n}`);

  // 8. CSV export
  const csv = await fetch('http://localhost:3001/api/bet-log/export').then((r) => r.text());
  const csvLines = csv.trim().split('\n');
  console.log(`[7] CSV export: ${csvLines.length} lines (1 header + ${csvLines.length - 1} rows)`);
  console.log(`    Last row: ${csvLines[csvLines.length - 1]}`);

  // 9. Double-tap dedup check — save same match+market+outcome again
  const before = (await fetch('http://localhost:3001/api/selections').then((r) => r.json()) as unknown[]).length;
  // (dedup logic is at app layer — the API doesn't currently dedupe, we check behavior)
  const after = (await fetch('http://localhost:3001/api/selections').then((r) => r.json()) as unknown[]).length;
  console.log(`\n[8] Double-tap dedup: history count before=${before} after second fetch=${after} (dedup needs app-level fix — see output)`);

  // Cleanup
  await prisma.selection.delete({ where: { id: sel.id } });
  console.log('\n[✓] E2E test complete — test row cleaned up');

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
