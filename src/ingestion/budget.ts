import { prisma } from '../db.js';

const HARD_CAP = 2000;

export async function checkBudget(provider: string): Promise<void> {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1);

  const rows = await prisma.apiBudget.findMany({
    where: { provider, date: { gte: monthStart, lt: monthEnd } },
  });

  const used = rows.reduce((sum, r) => sum + r.requests, 0);
  if (used >= HARD_CAP) {
    throw new Error(`API budget exhausted: ${used}/${HARD_CAP} requests used this month for ${provider}`);
  }
}

export async function recordRequest(provider: string, count = 1): Promise<void> {
  const today = new Date();
  const dateOnly = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));

  await prisma.apiBudget.upsert({
    where: { provider_date: { provider, date: dateOnly } },
    create: { provider, date: dateOnly, requests: count },
    update: { requests: { increment: count } },
  });
}

export async function getMonthlyUsage(provider: string): Promise<{ used: number; remaining: number; hardCap: number }> {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1);

  const rows = await prisma.apiBudget.findMany({
    where: { provider, date: { gte: monthStart, lt: monthEnd } },
  });

  const used = rows.reduce((sum, r) => sum + r.requests, 0);
  return { used, remaining: Math.max(0, HARD_CAP - used), hardCap: HARD_CAP };
}
