/**
 * Job type → payload map. Each domain augments it next to its handler
 * (module augmentation, lesson 01/02 §9), so `enqueue('auction.close', ...)`
 * is type-checked against the handler's payload without a central list:
 *
 *   declare module '@app/infrastructure/jobs/job-types' {
 *     interface JobPayloads { 'auction.close': { auctionId: string } }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JobPayloads {
  'jobs.partition-maintenance': { aheadDays?: number; retainDays?: number };
  /** Does nothing - used by `pnpm loadtest:jobs` to measure pure claim/complete throughput. */
  'jobs.noop': Record<string, never>;
}

export type JobType = keyof JobPayloads & string;

export type JobStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'DEAD' | 'CANCELLED';

export interface JobRow<T extends JobType = JobType> {
  id: string;
  type: T;
  payload: JobPayloads[T];
  status: JobStatus;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  shopId: string | null;
  /** Exact Postgres text (microseconds): part of the partitioned primary key, matched on every update. */
  createdAt: string;
}

export interface EnqueueOptions {
  runAt?: Date;
  /** Dedupes across retries of the *enqueue* (API retries, cron double-fire): same key → one job. */
  idempotencyKey?: string;
  /** Tenant for fairness caps (SD-02 / lesson 10/04 noisy neighbours). */
  shopId?: string;
  maxAttempts?: number;
}

export interface JobContext {
  attempt: number;
  /** Extends the lease; call periodically from long jobs (the worker also heartbeats automatically). */
  heartbeat(): Promise<void>;
  signal: AbortSignal;
}

export type JobHandlerFn<T extends JobType> = (
  payload: JobPayloads[T],
  ctx: JobContext,
) => Promise<void>;

/** Thrown by a handler to stop retrying immediately (bad payload, entity gone). */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}
