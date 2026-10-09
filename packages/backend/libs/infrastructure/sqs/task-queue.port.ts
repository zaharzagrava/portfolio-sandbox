export interface EnqueueOptions {
  /** Integer 0–900 s (SQS limit); not with a FIFO `groupId`. Longer delays go through the job scheduler (SD-29). */
  delaySeconds?: number;
  /** FIFO queues only: ordering + isolation scope (e.g. webhook endpoint id). */
  groupId?: string;
  /** FIFO queues only: 5-minute producer-side dedupe window. */
  dedupeId?: string;
  attributes?: Record<string, string>;
}

export interface TaskMessage<T> {
  id: string;
  body: T;
  receiveCount: number;
  attributes: Record<string, string>;
}

/** What `enqueueBatch` reports: entries the queue rejected are listed by their index in the input. */
export interface BatchResult {
  sent: number;
  failed: { index: number; reason: string }[];
}

/** Anything with a zod-style `safeParse`. */
export interface BodySchema {
  safeParse(input: unknown): { success: boolean };
}

export interface ConsumeOptions {
  /** Messages processed concurrently by this instance. */
  concurrency?: number;
  /** Visibility timeout; extended by heartbeat while the handler runs. */
  visibilityTimeoutSec?: number;
  waitTimeSec?: number;
  /** A body that fails this goes to the dead-letter queue at once (reason `SCHEMA_INVALID`); the handler is not called. */
  bodySchema?: BodySchema;
  /** Where invalid bodies go. Defaults to the queue's name with `-dlq` added before any `.fifo`. */
  deadLetterQueue?: string;
}

/**
 * Task queue port (D18): one worker per message, per-message retry via
 * visibility timeout, DLQ after maxReceiveCount (configured on the queue).
 */
export abstract class TaskQueue {
  /** Rejects with `InvalidEnqueueOptionsError` before any network call. */
  abstract enqueue<T>(
    queue: string,
    body: T,
    options?: EnqueueOptions,
  ): Promise<string>;
  /** Validates every entry first; sends in chunks of 10 and reports rejected entries instead of throwing. */
  abstract enqueueBatch<T>(
    queue: string,
    bodies: { body: T; options?: EnqueueOptions }[],
  ): Promise<BatchResult>;
  /** Starts a long-polling consumer; resolves the returned `stop()` once in-flight messages finish. */
  abstract consume<T>(
    queue: string,
    handler: (msg: TaskMessage<T>) => Promise<void>,
    options?: ConsumeOptions,
  ): () => Promise<void>;
}
