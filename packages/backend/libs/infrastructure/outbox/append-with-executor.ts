import { context, propagation } from '@opentelemetry/api';
import { eventEnvelopeSchema } from '@marketplace-sandbox/contracts';
import { MAX_EVENT_BYTES } from '../events/define-event';
import { EventEnvelope, topicFor } from '../events/event-envelope';
import {
  EventTooLargeError,
  InvalidEnvelopeError,
} from '../events/event-errors';
import { InvalidTaskError } from './outbox-errors';

/** What a framework-free writer needs: the query method every Postgres client has (`pg`, `postgres`, Sequelize bind). */
export interface OutboxExecutor {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

/** A single-consumer task for a queue (S53 FR-010): relayed to the queue, `body` cleared once sent. */
export interface OutboxTaskInput {
  queue: string;
  type: string;
  aggregateId: string;
  body: unknown;
  groupId?: string;
  delaySeconds?: number;
}

export type OutboxAppendInput =
  EventEnvelope | EventEnvelope[] | { task: OutboxTaskInput };

const COLUMNS = `"id", "kind", "topic", "aggregateId", "aggregateType", "type", "eventName", "payload", "status", "attempts", "nextAttemptAt", "createdAt"`;

/** Row values for one event: validates the envelope and the size limit, derives the topic. */
export function eventRow(
  event: EventEnvelope,
  topic: string = topicFor(event.aggregateType),
): unknown[] {
  const parsed = eventEnvelopeSchema.safeParse(event);
  if (!parsed.success)
    throw new InvalidEnvelopeError([
      ...new Set(parsed.error.issues.map((i) => i.path.join('.') || '(root)')),
    ]);
  const json = JSON.stringify(parsed.data);
  const bytes = Buffer.byteLength(json);
  if (bytes > MAX_EVENT_BYTES)
    throw new EventTooLargeError(event.type, MAX_EVENT_BYTES, bytes);
  return [
    'event',
    topic,
    event.aggregateId,
    event.aggregateType,
    event.type,
    json,
  ];
}

/** Row values for one task. */
export function taskRow(task: OutboxTaskInput): unknown[] {
  if (!task.queue) throw new InvalidTaskError('queue is required');
  if (!task.type) throw new InvalidTaskError('type is required');
  if (!task.aggregateId) throw new InvalidTaskError('aggregateId is required');
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const payload = JSON.stringify({
    body: task.body ?? null,
    ...(carrier.traceparent && { traceparent: carrier.traceparent }),
    ...(task.groupId !== undefined && { groupId: task.groupId }),
    ...(task.delaySeconds !== undefined && { delaySeconds: task.delaySeconds }),
  });
  return ['task', task.queue, task.aggregateId, null, task.type, payload];
}

/**
 * One multi-row INSERT in the row order given. `now` fills `nextAttemptAt` and `createdAt` (an injected clock);
 * without it the database clock is used.
 */
export function buildInsert(
  rows: unknown[][],
  now?: Date,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const nowRef = now ? `$${params.push(now)}` : 'now()';
  const values = rows.map((row) => {
    const [kind, topic, aggregateId, aggregateType, type, payload] = row;
    const ref = (value: unknown) => `$${params.push(value)}`;
    return `(uuidv7(), ${ref(kind)}, ${ref(topic)}, ${ref(aggregateId)}, ${ref(aggregateType)}, ${ref(type)}, ${ref(type)}, ${ref(payload)}::jsonb, 'pending', 0, ${nowRef}, ${nowRef})`;
  });
  return {
    sql: `INSERT INTO "Outbox" (${COLUMNS}) VALUES ${values.join(', ')}`,
    params,
  };
}

/**
 * Framework-free append (S53 FR-011, AS-08) for Lambda and other non-Nest writers: the caller owns the transaction
 * (BEGIN before, COMMIT after) and passes a connection of it. Same validation and row shape as `OutboxService`; the
 * topic is `<aggregateType>.events` (no registry here, the topic policy is enforced by the owning service).
 */
export async function appendWithExecutor(
  executor: OutboxExecutor,
  input: OutboxAppendInput,
  options: { now?: Date } = {},
): Promise<void> {
  const rows =
    !Array.isArray(input) && 'task' in input
      ? [taskRow(input.task)]
      : (Array.isArray(input) ? input : [input]).map((e) => eventRow(e));
  if (rows.length === 0) return;
  const { sql, params } = buildInsert(rows, options.now);
  await executor.query(sql, params);
}
