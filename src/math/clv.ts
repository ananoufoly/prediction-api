import { type DecimalOdds, type EdgePct, edgePct } from '../types/branded.js';

export interface ClvResult {
  clv: EdgePct;
  oddsAtSelection: DecimalOdds;
  closingOdds: DecimalOdds;
  won: boolean | null;
  pnl: number | null;
}

/**
 * CLV = (closingOdds / oddsAtSelection) - 1
 *
 * Positive: you got better odds than closing — evidence of skill/edge.
 * Negative: closing was better than your price — you were faded.
 *
 * CLV and P&L are fully decoupled:
 *   - A bet can win and have negative CLV (lucky, bad process)
 *   - A bet can lose and have positive CLV (unlucky, good process)
 * The system tracks both independently; CLV is the primary process signal.
 */
export function computeClv(
  oddsAtSelection: DecimalOdds,
  closingOdds: DecimalOdds,
): EdgePct {
  return edgePct(closingOdds / oddsAtSelection - 1);
}

/**
 * Batch compute CLV for a settled selection.
 * `won` and `pnl` are passed through untouched — CLV computation
 * must never branch on outcome to preserve decoupling.
 */
export function buildClvResult(
  oddsAtSelection: DecimalOdds,
  closingOdds: DecimalOdds,
  won: boolean | null,
  stake: number | null,
): ClvResult {
  const clv = computeClv(oddsAtSelection, closingOdds);

  let pnl: number | null = null;
  if (won !== null && stake !== null) {
    pnl = won ? stake * (oddsAtSelection - 1) : -stake;
  }

  return { clv, oddsAtSelection, closingOdds, won, pnl };
}
