import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import { exportAbortedCounter, exportActiveGauge } from '../domain/metrics';
import { ExportStopped } from '../application/statement-export.service';
import type { StatementsLifecycle } from './statements-lifecycle';

const logger = new Logger('StatementExport');
let active = 0;

/** SQLSTATE 57014: the database cancelled the statement at its timeout. */
const isStatementTimeout = (error: unknown): boolean => {
  const e = error as {
    parent?: { code?: string };
    original?: { code?: string };
    code?: string;
  };
  return (
    e?.parent?.code === '57014' ||
    e?.original?.code === '57014' ||
    e?.code === '57014'
  );
};

/** Resolves when the socket buffer drained or the client left; removes both listeners either way (no accumulation). */
const drainedOrGone = (res: Response): Promise<void> =>
  new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });

export type AbortReason = 'db_error' | 'timeout' | 'shutdown';

export const abortReasonOf = (error: unknown): AbortReason =>
  error instanceof ExportStopped
    ? 'shutdown'
    : isStatementTimeout(error)
      ? 'timeout'
      : 'db_error';

/**
 * Streams a CSV with back-pressure (S16 FR-040, research R-7). The first chunk is read before any header is written,
 * so a failure up to there is an ordinary problem+json answer from the exception filter. After the first byte a
 * failure destroys the response, so the client sees a failed transfer and never a file that looks complete; the
 * metric, a log line without any row, and the released slot follow. A client that goes away stops the work at once.
 */
export async function sendCsv(
  res: Response,
  chunks: AsyncGenerator<string>,
  options: {
    filename: string;
    lifecycle: StatementsLifecycle;
    context: Record<string, string>;
  },
): Promise<void> {
  const first = await chunks.next();

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${options.filename}"`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  // The head goes out now: a failure later destroys a response the client already saw start, so it reads as a failed
  // download and never as a connection that vanished before answering.
  res.flushHeaders();

  let gone = false;
  let cut: AbortReason | null = null;
  res.once('close', () => {
    gone = true;
  });
  const untrack = options.lifecycle.trackExport(() => {
    cut = 'shutdown';
    res.destroy();
  });
  exportActiveGauge.set(++active);
  try {
    let step = first;
    while (!step.done) {
      if (gone) break;
      if (!res.write(step.value)) await drainedOrGone(res);
      if (gone) break;
      step = await chunks.next();
    }
    if (gone) {
      await chunks.return(undefined);
      if (cut) exportAbortedCounter.add(1, { reason: cut });
      return;
    }
    res.end();
  } catch (error) {
    const reason = cut ?? abortReasonOf(error);
    exportAbortedCounter.add(1, { reason });
    logger.warn(
      `export aborted (${reason}) for ${JSON.stringify(options.context)}: ${(error as Error).name}`,
    );
    res.destroy(error as Error);
  } finally {
    untrack();
    exportActiveGauge.set(--active);
  }
}
