import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { RequestContext } from '@app/infrastructure/context';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { retryDelayMs } from './backoff';
import { claimJobs } from './job-claim.sql';
import { jobMetrics, JobOutcome } from './job-metrics';
import { JobRegistry, RegisteredHandler } from './job-registry.service';
import { nextStatus, sourceStatus } from './job-state';
import { parseJobPayload } from './job-type-registry';
import {
  JobAbortReason,
  JobContext,
  JobRow,
  NonRetryableJobError,
} from './job-types';
import { LeaseLostError } from './job-errors';
import { JOBS_WORKER_OPTIONS } from './jobs-worker-options';
import type { JobsWorkerOptions } from './jobs-worker-options';

/** How long in-flight jobs may keep running after shutdown began, before they are aborted and released. */
export const DRAIN_DEADLINE_MS = 25_000;
const LAST_ERROR_MAX = 2_000;
const WRITE_ATTEMPTS = 3;

type Settled =
  | { kind: 'done' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'aborted'; reason: JobAbortReason };

/**
 * At-least-once executor (lesson 10/09 #29):
 *  claim (SKIP LOCKED, lease) → run with heartbeat → SUCCEEDED | retry with
 *  backoff | DEAD after maxAttempts. Every write after the claim is fenced by the
 *  claim identity `(id, createdAt, lockedBy, attempts)` (R-04): a worker whose lease expired (and whose job was
 *  reaped and claimed again, even by itself) cannot change the new owner's result.
 */
@Injectable()
export class JobWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobWorker.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private draining = false;
  private loopDone?: Promise<void>;
  private wake = new AbortController();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly inFlightByType = new Map<string, number>();
  private readonly aborters = new Set<(reason: JobAbortReason) => void>();

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly registry: JobRegistry,
    private readonly requestContext: RequestContext,
    private readonly transactions: TransactionRunner,
    private readonly config: ApiConfigService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional()
    @Inject(JOBS_WORKER_OPTIONS)
    private readonly options: JobsWorkerOptions = {},
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'jobs-worker',
      order: 10,
      run: () => this.stop(),
      timeoutMs: DRAIN_DEADLINE_MS + 5_000,
    });
  }

  onApplicationBootstrap() {
    if (this.options.loops === false) return;
    this.loopDone = this.loop();
  }

  /** Exposed for specs and manual drains: claim + run one batch, wait for it. */
  async runOnce(limit = this.config.get('jobs_claim_batch')): Promise<number> {
    const jobs = await this.claim(limit);
    await Promise.all(jobs.map((job) => this.start(job)));
    return jobs.length;
  }

  /** Starts the claim loop; for specs that created the app with `loops: false` and want the loop. */
  startLoop(): void {
    this.draining = false;
    this.wake = new AbortController();
    this.loopDone ??= this.loop();
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (!this.draining) {
      try {
        const batch = this.config.get('jobs_claim_batch');
        const free = batch - this.inFlight.size;
        const jobs = free > 0 ? await this.claim(free) : [];
        failures = 0;
        for (const job of jobs) void this.start(job);
        if (jobs.length === 0)
          await sleep(
            this.config.get('jobs_poll_idle_ms'),
            this.wake.signal,
          ).catch(() => undefined);
        else if (this.inFlight.size >= batch)
          await Promise.race(this.inFlight.values());
      } catch (error) {
        // A database outage must not stop the loop: log, wait with exponential backoff and jitter, try again (FR-026).
        failures++;
        this.logger.error(`claim loop: ${(error as Error).message}`);
        await sleep(
          fullJitterBackoff(failures, { baseMs: 500, maxMs: 15_000 }),
          this.wake.signal,
        ).catch(() => undefined);
      }
    }
  }

  private async claim(limit: number): Promise<JobRow[]> {
    if (this.draining) return [];
    const types = this.registry.types().flatMap((type) => {
      const h = this.registry.get(type)!;
      return [
        {
          type,
          leaseMs: h.leaseMs,
          room: h.concurrency - (this.inFlightByType.get(type) ?? 0),
          fleetConcurrency: h.fleetConcurrency,
        },
      ];
    });
    const jobs = await claimJobs(this.sequelize, this.transactions, {
      workerId: this.workerId,
      now: this.clock.now(),
      limit,
      types,
      shopCap: this.config.get('jobs_per_shop_running_cap'),
    });
    // Reserve the slots before anything else can run, so two overlapping claims cannot both fill the same bulkhead.
    for (const job of jobs)
      this.inFlightByType.set(
        job.type,
        (this.inFlightByType.get(job.type) ?? 0) + 1,
      );
    return jobs;
  }

  /** Runs one claimed job and tracks it until it has been settled in the database. */
  private start(job: JobRow): Promise<void> {
    const run = this.execute(job)
      .catch((error) =>
        this.logger.error(this.line(job, 'execution failed', error)),
      )
      .finally(() => {
        this.inFlight.delete(job.id);
        this.inFlightByType.set(
          job.type,
          (this.inFlightByType.get(job.type) ?? 1) - 1,
        );
      });
    this.inFlight.set(job.id, run);
    return run;
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.registry.get(job.type)!;
    const started = this.clock.nowMs();
    const control = new AbortController();
    const abortWith = (reason: JobAbortReason) => {
      if (!control.signal.aborted) control.abort(reason);
    };
    this.aborters.add(abortWith);

    const leaseLost = () => {
      abortWith('lease_lost');
    };
    const heartbeat = async () => {
      if (!(await this.extendLease(job, handler))) {
        leaseLost();
        throw new LeaseLostError(job.id);
      }
    };
    const heartbeatTimer = setInterval(() => {
      heartbeat().catch((error) => {
        if (!(error instanceof LeaseLostError))
          this.logger.error(this.line(job, 'lease extension failed', error));
      });
    }, handler.leaseMs / 2);
    const runtimeTimer = setTimeout(
      () => abortWith('timeout'),
      handler.maxRuntimeMs,
    );
    heartbeatTimer.unref();
    runtimeTimer.unref();

    try {
      let payload: unknown;
      try {
        payload = parseJobPayload(job.type, job.payload);
      } catch (error) {
        await this.fail(job, error as Error, true);
        return;
      }

      const context: JobContext = {
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        isLastAttempt: job.attempts >= job.maxAttempts,
        heartbeat,
        signal: control.signal,
      };
      const handlerRun = this.requestContext.run(
        {
          requestId: `job:${job.id}`,
          shopId: job.shopId ?? undefined,
          principalType: 'service',
          traceparent: job.traceparent ?? undefined,
        },
        () => handler.run(payload, context),
      );
      // A run that is abandoned (timeout, lease lost, shutdown) may still settle later; that must not be unhandled.
      handlerRun.catch(() => undefined);
      const aborted = new Promise<Settled>((resolve) =>
        control.signal.addEventListener(
          'abort',
          () =>
            resolve({
              kind: 'aborted',
              reason: control.signal.reason as JobAbortReason,
            }),
          { once: true },
        ),
      );
      const settled = await Promise.race([
        handlerRun.then(
          (): Settled => ({ kind: 'done' }),
          (error): Settled => ({ kind: 'failed', error }),
        ),
        aborted,
      ]);

      switch (settled.kind) {
        case 'done':
          await this.complete(job);
          break;
        case 'failed':
          await this.fail(job, settled.error);
          break;
        case 'aborted':
          await this.afterAbort(job, settled.reason);
          break;
      }
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(runtimeTimer);
      this.aborters.delete(abortWith);
      jobMetrics.recordDuration(this.clock.nowMs() - started, job.type);
    }
  }

  private async afterAbort(job: JobRow, reason: JobAbortReason) {
    switch (reason) {
      case 'timeout':
        return this.fail(
          job,
          new Error(
            `exceeded maxRuntimeMs (${this.registry.get(job.type)!.maxRuntimeMs} ms)`,
          ),
          false,
          'timeout',
        );
      case 'lease_lost':
        // Someone else owns the job now; every write of ours would be fenced anyway.
        this.logger.warn(this.line(job, 'lease lost, abandoning the run'));
        return;
      case 'shutdown':
        return this.release(job);
    }
  }

  /** Fence: only the current claim (worker and attempt number) of a RUNNING job may change it. */
  private readonly fence = `id = :id AND "createdAt" = :createdAt AND status = :from AND "lockedBy" = :workerId AND attempts = :attempts`;

  private fenceReplacements(
    job: JobRow,
    event: Parameters<typeof nextStatus>[1],
  ) {
    return {
      id: job.id,
      createdAt: job.createdAt,
      workerId: this.workerId,
      attempts: job.attempts,
      from: sourceStatus(event),
      to: nextStatus('RUNNING', event),
      now: this.clock.now(),
    };
  }

  /** Runs a fenced write; retries transient failures up to 3 times with full jitter. Returns whether a row changed. */
  private async fencedWrite(
    job: JobRow,
    sql: string,
    replacements: Record<string, unknown>,
  ): Promise<boolean | undefined> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      try {
        const rows = await this.sequelize.query<{ id: string }>(sql, {
          type: QueryTypes.SELECT,
          replacements,
        });
        return rows.length > 0;
      } catch (error) {
        if (attempt + 1 === WRITE_ATTEMPTS) {
          // Left RUNNING: the reaper re-queues it when the lease runs out (at-least-once).
          this.logger.error(
            this.line(
              job,
              'could not record the result, leaving it to the reaper',
              error,
            ),
          );
          return undefined;
        }
        await sleep(fullJitterBackoff(attempt, { baseMs: 50, maxMs: 1_000 }));
      }
    }
    return undefined;
  }

  private async complete(job: JobRow): Promise<void> {
    const applied = await this.fencedWrite(
      job,
      `UPDATE "Job" SET status = :to, "finishedAt" = :now, "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = NULL
       WHERE ${this.fence} RETURNING id`,
      this.fenceReplacements(job, 'complete'),
    );
    this.settled(job, applied, 'succeeded');
  }

  private async fail(
    job: JobRow,
    error: unknown,
    invalidPayload = false,
    outcomeWhenRetried: JobOutcome = 'retry',
  ): Promise<void> {
    const dead =
      invalidPayload ||
      error instanceof NonRetryableJobError ||
      job.attempts >= job.maxAttempts;
    const message = invalidPayload
      ? `invalid payload: ${(error as { fields?: string[] }).fields?.join(', ') ?? ''}`
      : error instanceof Error
        ? error.message
        : String(error);
    const event = dead ? 'fail' : 'retry';
    const delayMs = retryDelayMs(job.attempts);
    this.logger.warn(
      this.line(job, `attempt failed${dead ? ', no retry left' : ''}`, error),
    );
    const applied = await this.fencedWrite(
      job,
      `UPDATE "Job" SET status = :to,
         "runAt" = CASE WHEN :dead THEN "runAt" ELSE CAST(:now AS timestamptz) + :delayMs * interval '1 millisecond' END,
         "finishedAt" = CASE WHEN :dead THEN CAST(:now AS timestamptz) ELSE NULL END,
         "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = :lastError
       WHERE ${this.fence} RETURNING id`,
      {
        ...this.fenceReplacements(job, event),
        dead,
        delayMs,
        lastError: message.slice(0, LAST_ERROR_MAX),
      },
    );
    this.settled(job, applied, dead ? 'dead' : outcomeWhenRetried);
  }

  /** Shutdown: hand the job back at once and refund the attempt so another worker takes it without waiting. */
  private async release(job: JobRow): Promise<void> {
    const applied = await this.fencedWrite(
      job,
      `UPDATE "Job" SET status = :to, "runAt" = :now, attempts = attempts - 1,
         "lockedBy" = NULL, "lockedUntil" = NULL
       WHERE ${this.fence} RETURNING id`,
      this.fenceReplacements(job, 'release'),
    );
    this.settled(job, applied, 'released');
  }

  private settled(
    job: JobRow,
    applied: boolean | undefined,
    outcome: JobOutcome,
  ) {
    if (applied === undefined) return;
    if (!applied) {
      this.logger.warn(
        this.line(
          job,
          `result not recorded, another claim owns the job (${outcome})`,
        ),
      );
      return;
    }
    jobMetrics.outcomes.add(1, { type: job.type, outcome });
  }

  private async extendLease(
    job: JobRow,
    handler: RegisteredHandler,
  ): Promise<boolean> {
    const rows = await this.sequelize.query<{ id: string }>(
      `UPDATE "Job" SET "lockedUntil" = CAST(:now AS timestamptz) + :leaseMs * interval '1 millisecond'
       WHERE ${this.fence} RETURNING id`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          ...this.fenceReplacements(job, 'complete'),
          leaseMs: handler.leaseMs,
        },
      },
    );
    return rows.length > 0;
  }

  /** One structured log line: ids and the error only, never the payload (FR-023). */
  private line(job: JobRow, message: string, error?: unknown) {
    return {
      message,
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      shopId: job.shopId ?? undefined,
      requestId: `job:${job.id}`,
      enqueuedByRequestId: job.enqueuedByRequestId ?? undefined,
      traceId: job.traceparent?.split('-')[1],
      error:
        error === undefined
          ? undefined
          : `${(error as Error).name}: ${String((error as Error).message).slice(0, 200)}`,
    };
  }

  /**
   * Stops claiming, lets in-flight jobs finish for up to `drainMs`, then aborts the rest with reason `shutdown` and
   * releases them (FR-025). Resolves once every release write is done.
   */
  async stop(drainMs = DRAIN_DEADLINE_MS): Promise<void> {
    this.draining = true;
    this.wake.abort();
    await this.loopDone;
    const settled = Promise.allSettled([...this.inFlight.values()]);
    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        for (const abort of this.aborters) abort('shutdown');
        resolve();
      }, drainMs);
    });
    await Promise.race([settled, expired]);
    clearTimeout(deadline);
    await settled;
  }
}
