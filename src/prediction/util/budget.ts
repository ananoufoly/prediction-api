import { prisma } from '../../db.js';

/**
 * Per-provider budget gate for the prediction engine, reusing the shared
 * `ApiBudget` table (keyed by provider+date) but with provider-specific caps.
 *
 * The existing edge-model budget.ts hard-codes 2000/month for The Odds API and
 * is left untouched. New providers register their own cap here. API-Football
 * free tier is 100 req/DAY (not month), so we track a daily cap for it.
 */

interface Cap {
  limit: number;
  window: 'day' | 'month';
}

const CAPS: Record<string, Cap> = {
  // API-Football free plan: 100 requests/day.
  api_football: { limit: 100, window: 'day' },
};

function dateOnlyUtc(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function usage(provider: string, window: 'day' | 'month'): Promise<number> {
  const now = new Date();
  let gte: Date;
  let lt: Date;
  if (window === 'day') {
    gte = dateOnlyUtc(now);
    lt = new Date(gte.getTime() + 86_400_000);
  } else {
    gte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    lt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  }
  const rows = await prisma.apiBudget.findMany({
    where: { provider, date: { gte, lt } },
  });
  return rows.reduce((s, r) => s + r.requests, 0);
}

/** Throws if the provider's window budget is exhausted. Unknown providers are uncapped. */
export async function checkProviderBudget(provider: string): Promise<void> {
  const cap = CAPS[provider];
  if (!cap) return;
  const used = await usage(provider, cap.window);
  if (used >= cap.limit) {
    throw new Error(
      `Budget exhausted for ${provider}: ${used}/${cap.limit} requests this ${cap.window}`,
    );
  }
}

/** Returns how many requests remain in the current window (Infinity if uncapped). */
export async function remainingProviderBudget(provider: string): Promise<number> {
  const cap = CAPS[provider];
  if (!cap) return Infinity;
  const used = await usage(provider, cap.window);
  return Math.max(0, cap.limit - used);
}

export async function recordProviderRequest(provider: string, count = 1): Promise<void> {
  const date = dateOnlyUtc();
  await prisma.apiBudget.upsert({
    where: { provider_date: { provider, date } },
    create: { provider, date, requests: count },
    update: { requests: { increment: count } },
  });
}
