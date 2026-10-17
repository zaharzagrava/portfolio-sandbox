import { log } from '../telemetry/telemetry';
import type { SqsBatchResponse, SqsEvent, SqsRecord } from './sqs-types';

export const DEFAULT_CONCURRENCY = 10;
export const DEFAULT_DEADLINE_MARGIN_MS = 5_000;

export interface ProcessBatchOptions {
  /** Records in flight at once (default 10). On FIFO queues it bounds the groups running together. */
  concurrency?: number;
  /** Stop starting records when fewer than this many ms remain (default 5 s). Needs `remainingTimeMs`. */
  deadlineMarginMs?: number;
  /** `context.getRemainingTimeInMillis` of the invocation. */
  remainingTimeMs?: () => number;
  /** Called once for each record whose handler failed. Must not throw. */
  onFailure?: (record: SqsRecord, error: unknown) => void;
  /** Called once for each record that was not run (earlier failure in its group, or the deadline). */
  onSkipped?: (record: SqsRecord, reason: 'group_failed' | 'deadline') => void;
}

/**
 * Partial batch failure (06/01 §3, ReportBatchItemFailures): one bad record
 * must not make SQS redeliver the whole batch (re-running the 9 that
 * succeeded). Only failed message ids are returned, each once, in input order.
 *
 * FIFO queues: the records of one message group run one at a time in input
 * order and once one fails, every LATER record of the same group in this batch
 * is reported failed without running (running them would break the group's
 * order). Different groups are independent and run together. Standard queues
 * run records concurrently (bounded). Once the remaining invocation time falls
 * below the margin, records not yet started are reported failed.
 */
export async function processBatch(
  event: SqsEvent,
  handle: (record: SqsRecord) => Promise<void>,
  options: ProcessBatchOptions = {},
): Promise<SqsBatchResponse> {
  const records = event.Records;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  // A margin larger than half the whole budget would skip every record of a short-timeout function.
  const margin = Math.min(
    options.deadlineMarginMs ?? DEFAULT_DEADLINE_MARGIN_MS,
    (options.remainingTimeMs?.() ?? Infinity) / 2,
  );
  const fifo = records.some((r) => r.eventSourceARN.endsWith('.fifo'));
  const failed = new Set<string>();

  // Units run concurrently; the records inside a unit run in order. A standard record is a unit of its own.
  const units: SqsRecord[][] = [];
  if (fifo) {
    const groups = new Map<string, SqsRecord[]>();
    for (const record of records) {
      const key = record.attributes.MessageGroupId ?? '';
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    units.push(...groups.values());
  } else {
    units.push(...records.map((r) => [r]));
  }

  const skip = (record: SqsRecord, reason: 'group_failed' | 'deadline') => {
    failed.add(record.messageId);
    safely(() => options.onSkipped?.(record, reason));
  };
  const outOfTime = () =>
    options.remainingTimeMs !== undefined && options.remainingTimeMs() < margin;

  let next = 0;
  const worker = async () => {
    while (next < units.length) {
      const unit = units[next++];
      for (let i = 0; i < unit.length; i++) {
        const record = unit[i];
        if (outOfTime()) {
          for (const rest of unit.slice(i)) skip(rest, 'deadline');
          break;
        }
        try {
          await handle(record);
        } catch (error) {
          failed.add(record.messageId);
          safely(() => options.onFailure?.(record, error));
          for (const rest of unit.slice(i + 1)) skip(rest, 'group_failed');
          break;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, units.length) }, worker),
  );

  return {
    batchItemFailures: records
      .filter((r) => failed.has(r.messageId))
      .map((r) => ({ itemIdentifier: r.messageId })),
  };
}

function safely(fn: () => void) {
  try {
    fn();
  } catch (error) {
    log('warn', 'batch callback failed', { error: errorName(error) });
  }
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
