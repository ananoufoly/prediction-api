import { prisma } from '../../db.js';

export type Sport = 'football' | 'tennis' | 'nba' | 'nfl' | 'mlb' | 'rugby' | 'football_intl' | 'rugby_intl';

/**
 * Wraps an ingestion task with a row in `prediction_ingestion_runs` so gaps,
 * failures, and row counts are auditable per sport/source. Returns whatever the
 * task returns. The task receives a mutable counter object it can bump as it
 * writes rows; the final value is persisted.
 */
export async function withRunLog<T>(
  sport: Sport,
  source: string,
  task: (ctx: { addRows: (n: number) => void; note: (s: string) => void }) => Promise<T>,
): Promise<T> {
  const run = await prisma.ingestionRun.create({
    data: { sport, source, ok: false },
  });

  let rows = 0;
  const notes: string[] = [];
  const ctx = {
    addRows: (n: number) => { rows += n; },
    note: (s: string) => { notes.push(s); },
  };

  try {
    const result = await task(ctx);
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        rowsWritten: rows,
        ok: true,
        note: notes.length ? notes.join(' | ') : null,
      },
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        rowsWritten: rows,
        ok: false,
        note: [...notes, `ERROR: ${msg}`].join(' | '),
      },
    });
    throw err;
  }
}
