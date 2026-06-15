import { computeXgRatings } from '../model/xgRatings.js';
import { computeMatchProbs } from '../model/poisson.js';
import { prisma } from '../db.js';

async function main() {
  const lr = await computeXgRatings('EPL');
  const teams = [...lr.teams.values()];
  teams.sort((a, b) => b.attack - a.attack);

  const top = teams[0]!;
  const bottom = teams[teams.length - 1]!;
  const mid = teams[Math.floor(teams.length / 2)]!;

  console.log(`\nEPL — testing Poisson predictions (avg goals/game: ${lr.leagueAvgAttack.toFixed(3)})`);

  const scenarios = [
    { label: `Top (${top.team}) vs Bottom (${bottom.team})`, home: top, away: bottom },
    { label: `Bottom (${bottom.team}) vs Top (${top.team})`, home: bottom, away: top },
    { label: `Top (${top.team}) vs Mid (${mid.team})`, home: top, away: mid },
    { label: `Mid (${mid.team}) vs Mid (${mid.team})`, home: mid, away: mid },
  ];

  for (const s of scenarios) {
    const p = computeMatchProbs(
      s.home.attack, s.home.defense,
      s.away.attack, s.away.defense,
      lr.leagueAvgAttack,
    );
    console.log(`\n  ${s.label}`);
    console.log(`    λ_home=${p.scoreMatrix.lambdaHome.toFixed(3)}  λ_away=${p.scoreMatrix.lambdaAway.toFixed(3)}`);
    console.log(`    P(home win)=${(p.pHome * 100).toFixed(1)}%  P(draw)=${(p.pDraw * 100).toFixed(1)}%  P(away win)=${(p.pAway * 100).toFixed(1)}%`);
    console.log(`    P(over 2.5)=${(p.pOver25 * 100).toFixed(1)}%  P(BTTS)=${(p.pBtts * 100).toFixed(1)}%`);
  }

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
