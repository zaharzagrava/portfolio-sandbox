/** SQS → Lambda event shapes (subset; avoids a dependency on @types/aws-lambda). */
export interface SqsRecord {
  messageId: string;
  receiptHandle: string;
  body: string;
  attributes: { ApproximateReceiveCount: string; MessageGroupId?: string; SentTimestamp?: string };
  eventSourceARN: string;
}
export interface SqsEvent {
  Records: SqsRecord[];
}
export interface SqsBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/**
 * Partial batch failure (06/01 §3, ReportBatchItemFailures): one bad record
 * must not make SQS redeliver the whole batch (re-running the 9 that
 * succeeded). Only failed message ids are returned.
 *
 * FIFO queues: records of a message group are ordered; once one fails, every
 * LATER record of the same group in this batch is also reported failed
 * without running - processing them would break the group's order.
 * Standard queues run records concurrently (bounded).
 */
export async function processBatch(
  event: SqsEvent,
  handle: (record: SqsRecord) => Promise<void>,
  { concurrency = 10 }: { concurrency?: number } = {},
): Promise<SqsBatchResponse> {
  const fifo = event.Records.some((r) => r.eventSourceARN.endsWith('.fifo'));
  const failures: string[] = [];

  if (fifo) {
    const failedGroups = new Set<string>();
    for (const record of event.Records) {
      const group = record.attributes.MessageGroupId ?? '';
      if (failedGroups.has(group)) {
        failures.push(record.messageId);
        continue;
      }
      try {
        await handle(record);
      } catch {
        failedGroups.add(group);
        failures.push(record.messageId);
      }
    }
  } else {
    let next = 0;
    const worker = async () => {
      while (next < event.Records.length) {
        const record = event.Records[next++];
        try {
          await handle(record);
        } catch {
          failures.push(record.messageId);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, event.Records.length) }, worker));
  }
  return { batchItemFailures: event.Records.filter((r) => failures.includes(r.messageId)).map((r) => ({ itemIdentifier: r.messageId })) };
}
