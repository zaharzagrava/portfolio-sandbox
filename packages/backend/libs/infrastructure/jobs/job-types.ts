/**
 * Job type → payload map. Each domain augments it next to its handler
 * (module augmentation, lesson 01/02 §9), so `enqueue('auction.close', ...)`
 * is type-checked against the handler's payload without a central list:
 *
 *   declare module '@app/infrastructure/jobs/job-types' {
 *     interface JobPayloads { 'auction.close': { auctionId: string } }
 *   }
 */

export interface JobPayloads {
  'jobs.partition-maintenance': { aheadDays?: number; retainDays?: number };
  /** Does nothing - used by `pnpm loadtest:jobs` to measure pure claim/complete throughput. */
  'jobs.noop': Record<string, never>;
}

export type JobType = keyof JobPayloads & string;

import type { JobStatus } from './job-state';
export type { JobStatus } from './job-state';

export interface JobRow<T extends JobType = JobType> {
  id: string;
  type: T;
  payload: JobPayloads[T];
  status: JobStatus;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  shopId: string | null;
  enqueuedByRequestId: string | null;
  traceparent: string | null;
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

/** Result of `cancel` / `cancelByKey`: only a QUEUED job can be cancelled; another shop's job is NOT_FOUND. */
export type CancelResult =
  | { outcome: 'CANCELLED' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'CONFLICT'; status: JobStatus };

/** Why a run's signal aborted: it ran past `maxRuntimeMs`, its lease was taken over, or the worker is shutting down. */
export type JobAbortReason = 'timeout' | 'lease_lost' | 'shutdown';

export interface JobContext {
  jobId: string;
  attempt: number;
  maxAttempts: number;
  /** True when a failure of this run sends the job to DEAD (no retry left). */
  isLastAttempt: boolean;
  /** Extends the lease; call periodically from long jobs (the worker also heartbeats automatically). */
  heartbeat(): Promise<void>;
  /** Aborted with `signal.reason` set to a `JobAbortReason`. */
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
