export interface EnqueueOptions {
  /** ≤ 900 s (SQS limit). Longer delays go through the job scheduler (SD-29). */
  delaySeconds?: number;
  /** FIFO queues only: ordering + isolation scope (e.g. webhook endpoint id). */
  groupId?: string;
  /** FIFO queues only: 5-minute producer-side dedupe window. */
  deduplicationId?: string;
  attributes?: Record<string, string>;
}

export interface TaskMessage<T> {
  id: string;
  body: T;
  receiveCount: number;
  attributes: Record<string, string>;
}

export interface ConsumeOptions {
  /** Messages processed concurrently by this instance. */
  concurrency?: number;
  /** Visibility timeout; extended by heartbeat while the handler runs. */
  visibilityTimeoutSec?: number;
  waitTimeSec?: number;
}

/**
 * Task queue port (D18): one worker per message, per-message retry via
 * visibility timeout, DLQ after maxReceiveCount (configured on the queue).
 */
export abstract class TaskQueue {
  abstract enqueue<T>(queue: string, body: T, options?: EnqueueOptions): Promise<string>;
  abstract enqueueBatch<T>(queue: string, bodies: { body: T; options?: EnqueueOptions }[]): Promise<void>;
  /** Starts a long-polling consumer; resolves the returned `stop()` once in-flight messages finish. */
  abstract consume<T>(queue: string, handler: (msg: TaskMessage<T>) => Promise<void>, options?: ConsumeOptions): () => Promise<void>;
}
