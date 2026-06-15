import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../db.js', () => ({
  prisma: {
    match: {
      upsert: vi.fn().mockResolvedValue({ id: 'match-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    oddsSnapshot: {
      create: vi.fn().mockResolvedValue({}),
    },
    apiBudget: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock('../env.js', () => ({
  env: { ODDS_API_KEY: 'test-key', PORT: 3001, NODE_ENV: 'test' },
}));

import { prisma } from '../db.js';
import { checkBudget, recordRequest, getMonthlyUsage } from '../ingestion/budget.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = MockInstance<any[], any>;

const mp = prisma as unknown as {
  apiBudget: { findMany: AnyMock; upsert: AnyMock };
  match: { upsert: AnyMock; findFirst: AnyMock; update: AnyMock };
  oddsSnapshot: { create: AnyMock };
};

describe('budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mp.apiBudget.findMany.mockResolvedValue([]);
    mp.apiBudget.upsert.mockResolvedValue({});
  });

  it('allows requests when budget is empty', async () => {
    await expect(checkBudget('odds-api')).resolves.toBeUndefined();
  });

  it('throws when hard cap reached', async () => {
    mp.apiBudget.findMany.mockResolvedValue([{ requests: 450 }]);
    await expect(checkBudget('odds-api')).rejects.toThrow(/budget exhausted/i);
  });

  it('throws at exactly 450 (sum of two rows)', async () => {
    mp.apiBudget.findMany.mockResolvedValue([{ requests: 300 }, { requests: 150 }]);
    await expect(checkBudget('odds-api')).rejects.toThrow(/budget exhausted/i);
  });

  it('allows at 449', async () => {
    mp.apiBudget.findMany.mockResolvedValue([{ requests: 449 }]);
    await expect(checkBudget('odds-api')).resolves.toBeUndefined();
  });

  it('recordRequest upserts with correct increment', async () => {
    await recordRequest('odds-api', 3);
    expect(mp.apiBudget.upsert).toHaveBeenCalledOnce();
    const call = mp.apiBudget.upsert.mock.calls[0]?.[0] as { create: { requests: number }; update: { requests: { increment: number } } };
    expect(call.create.requests).toBe(3);
    expect(call.update.requests.increment).toBe(3);
  });

  it('getMonthlyUsage sums all rows', async () => {
    mp.apiBudget.findMany.mockResolvedValue([{ requests: 100 }, { requests: 50 }]);
    const result = await getMonthlyUsage('odds-api');
    expect(result.used).toBe(150);
    expect(result.remaining).toBe(300);
    expect(result.hardCap).toBe(450);
  });

  it('remaining floors at 0 when over cap', async () => {
    mp.apiBudget.findMany.mockResolvedValue([{ requests: 500 }]);
    const result = await getMonthlyUsage('odds-api');
    expect(result.remaining).toBe(0);
  });
});

describe('openfootball idempotency', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uses upsert for all matches (guarantees idempotency)', async () => {
    const { backfillOpenfootball } = await import('../ingestion/openfootball.js');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rounds: [{
          name: 'Matchday 1',
          matches: [{ date: '2024-08-16', time: '20:00', team1: 'Arsenal FC', team2: 'Wolves', score: { ft: [2, 0] } }],
        }],
      }),
    } as Response);

    await backfillOpenfootball();

    expect(mp.match.upsert).toHaveBeenCalled();
    for (const call of mp.match.upsert.mock.calls) {
      const arg = call[0] as Record<string, unknown>;
      expect(arg).toHaveProperty('where');
      expect(arg).toHaveProperty('update');
    }
  });
});

describe('espn scores idempotency', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('maps completed events to FINAL with goals', async () => {
    const { fetchEspnScores } = await import('../ingestion/espnScores.js');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [{
          id: 'esp-1',
          date: '2024-08-16T19:00Z',
          status: { type: { name: 'STATUS_FINAL', completed: true, state: 'post' } },
          competitions: [{
            competitors: [
              { homeAway: 'home', team: { displayName: 'Arsenal', shortDisplayName: 'ARS' }, score: '2' },
              { homeAway: 'away', team: { displayName: 'Wolves', shortDisplayName: 'WOL' }, score: '0' },
            ],
          }],
        }],
      }),
    } as Response);

    await fetchEspnScores('EPL');

    expect(mp.match.upsert).toHaveBeenCalledOnce();
    const arg = mp.match.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(arg.create['status']).toBe('FINAL');
    expect(arg.create['homeGoals']).toBe(2);
    expect(arg.create['awayGoals']).toBe(0);
    expect(arg.update['status']).toBe('FINAL');
  });

  it('does not set goals for scheduled matches', async () => {
    const { fetchEspnScores } = await import('../ingestion/espnScores.js');

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [{
          id: 'esp-2',
          date: '2025-06-01T15:00Z',
          status: { type: { name: 'STATUS_SCHEDULED', completed: false, state: 'pre' } },
          competitions: [{
            competitors: [
              { homeAway: 'home', team: { displayName: 'Chelsea', shortDisplayName: 'CHE' }, score: '0' },
              { homeAway: 'away', team: { displayName: 'Liverpool', shortDisplayName: 'LIV' }, score: '0' },
            ],
          }],
        }],
      }),
    } as Response);

    await fetchEspnScores('EPL');

    const arg = mp.match.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(arg.create['status']).toBe('SCHEDULED');
    expect(arg.create['homeGoals']).toBeNull();
    expect(arg.update).not.toHaveProperty('homeGoals');
  });
});
