/** A value in [0, 1] representing a probability. */
export type Probability = number & { readonly __brand: 'Probability' };

/** A decimal odds value strictly > 1.0 (e.g. 2.10). */
export type DecimalOdds = number & { readonly __brand: 'DecimalOdds' };

/** An edge expressed as a percentage (e.g. 4.5 means +4.5%). May be negative. */
export type EdgePct = number & { readonly __brand: 'EdgePct' };

/** Constructors — the only way to create branded values at runtime. Brands are type-system only. */

export function prob(n: number): Probability {
  if (n < 0 || n > 1) throw new RangeError(`Probability must be in [0,1], got ${n}`);
  return n as Probability;
}

export function odds(n: number): DecimalOdds {
  if (n <= 1) throw new RangeError(`Decimal odds must be > 1, got ${n}`);
  return n as DecimalOdds;
}

export function edgePct(n: number): EdgePct {
  return n as EdgePct;
}
