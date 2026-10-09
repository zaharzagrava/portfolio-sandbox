import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import { JobRegistry, RegisteredHandler } from './job-registry.service';
import { JobRow, NonRetryableJobError } from './job-types';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { RequestContext } from '@app/infrastructure/context';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';

const POLL_IDLE_MS = 500;
const CLAIM_BATCH = 50;
/** Max RUNNING jobs per shop across the fleet - one shop's 1M-row import can't starve everyone else. */
const PER_SHOP_RUNNING_CAP = 5;

/**
 * At-least-once executor (lesson 10/09 #29):
 *  claim (SKIP LOCKED, lease) → run with heartbeat → SUCCEEDED | retry with
 *  backoff | DEAD after maxAttempts. Every completion UPDATE is fenced by
 *  `lockedBy = me`, so a worker whose lease expired (and whose job was reaped
 *  and re-claimed) can't overwrite the new owner's result.
 */
@Injectable()
export class JobWorker implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobWorker.name);
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private running = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly inFlightByType = new Map<string, number>();
  private loopDone?: Promise<void>;
  private readonly abort = new AbortController();

  private readonly meter = metrics.getMeter('jobs');
  private readonly duration = this.meter.createHistogram('job_duration_ms', {
    unit: 'ms',
  });
  private readonly outcomes = this.meter.createCounter('job_outcomes_total');

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly registry: JobRegistry,
    private readonly requestContext: RequestContext,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'jobs.worker.drain',
      order: 10,
      run: () => this.stop(),
      timeoutMs: 25_000,
    });
  }

  onApplicationBootstrap() {
    this.running = true;
    this.loopDone = this.loop();
  }

  /** Exposed for specs and manual drains: claim + run one batch, wait for it. */
  async runOnce(limit = CLAIM_BATCH): Promise<number> {
    const jobs = await this.claim(limit);
    await Promise.all(jobs.map((job) => this.execute(job)));
    return jobs.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const free = CLAIM_BATCH - this.inFlight.size;
        const jobs = free > 0 ? await this.claim(free) : [];
        for (const job of jobs) {
          const run = this.execute(job).finally(() =>
            this.inFlight.delete(job.id),
          );
          this.inFlight.set(job.id, run);
        }
        if (jobs.length === 0) await sleep(POLL_IDLE_MS);
        else if (this.inFlight.size >= CLAIM_BATCH)
          await Promise.race(this.inFlight.values());
      } catch (error) {
        this.logger.error(`claim loop: ${(error as Error).message}`);
        await sleep(1_000);
      }
    }
  }

  private async claim(limit: number): Promise<JobRow[]> {
    const types = this.registry
      .types()
      .filter(
        (t) =>
          (this.inFlightByType.get(t) ?? 0) <
          (this.registry.get(t)?.concurrency ?? 10),
      );
    if (types.length === 0) return [];

    return this.sequelize.query<JobRow>(
      `
      UPDATE "Job" j
      SET status = 'RUNNING', "lockedBy" = :workerId, attempts = j.attempts + 1,
          "lockedUntil" = now() + interval '60 seconds'
      FROM (
        SELECT id, "createdAt" FROM "Job"
        WHERE status = 'QUEUED' AND "runAt" <= now() AND type IN (:types)
          AND ("shopId" IS NULL OR "shopId" NOT IN (
            SELECT "shopId" FROM "Job" WHERE status = 'RUNNING' AND "shopId" IS NOT NULL
            GROUP BY "shopId" HAVING count(*) >= :shopCap
          ))
        ORDER BY "runAt"
        LIMIT :limit
        FOR UPDATE SKIP LOCKED
      ) due
      WHERE j.id = due.id AND j."createdAt" = due."createdAt"
      RETURNING j.id, j.type, j.payload, j.status, j."runAt", j.attempts, j."maxAttempts", j."shopId",
        -- as text: a JS Date keeps only milliseconds, and the later "createdAt" = :createdAt matches need microseconds
        j."createdAt"::text AS "createdAt"
      `,
      {
        type: QueryTypes.SELECT,
        replacements: {
          workerId: this.workerId,
          types,
          limit,
          shopCap: PER_SHOP_RUNNING_CAP,
        },
      },
    );
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.registry.get(job.type);
    if (!handler)
      return this.fail(
        job,
        new NonRetryableJobError(`no handler for ${job.type}`),
      );

    this.inFlightByType.set(
      job.type,
      (this.inFlightByType.get(job.type) ?? 0) + 1,
    );
    const started = Date.now();
    const heartbeat = () => this.extendLease(job, handler);
    const timer = setInterval(
      () => void heartbeat().catch(() => undefined),
      handler.leaseMs / 2,
    );
    timer.unref();

    try {
      await this.extendLease(job, handler); // set the handler-specific lease right away
      await this.requestContext.run(
        {
          requestId: `job:${job.id}`,
          shopId: job.shopId ?? undefined,
          principalType: 'service',
        },
        () =>
          handler.run(job.payload, {
            attempt: job.attempts,
            heartbeat,
            signal: this.abort.signal,
          }),
      );
      await this.finish(job, 'SUCCEEDED');
      this.outcomes.add(1, { type: job.type, outcome: 'succeeded' });
    } catch (error) {
      await this.fail(job, error as Error);
    } finally {
      clearInterval(timer);
      this.inFlightByType.set(
        job.type,
        (this.inFlightByType.get(job.type) ?? 1) - 1,
      );
      this.duration.record(Date.now() - started, { type: job.type });
    }
  }

  private async extendLease(job: JobRow, handler: RegisteredHandler) {
    await this.sequelize.query(
      `UPDATE "Job" SET "lockedUntil" = now() + (:leaseMs || ' milliseconds')::interval
       WHERE id = :id AND "createdAt" = :createdAt AND "lockedBy" = :workerId AND status = 'RUNNING'`,
      {
        replacements: {
          id: job.id,
          createdAt: job.createdAt,
          workerId: this.workerId,
          leaseMs: handler.leaseMs,
        },
      },
    );
  }

  private async finish(job: JobRow, status: 'SUCCEEDED') {
    await this.sequelize.query(
      `UPDATE "Job" SET status = :status, "finishedAt" = now(), "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = NULL
       WHERE id = :id AND "createdAt" = :createdAt AND "lockedBy" = :workerId`,
      {
        replacements: {
          status,
          id: job.id,
          createdAt: job.createdAt,
          workerId: this.workerId,
        },
      },
    );
  }

  private async fail(job: JobRow, error: Error) {
    const dead =
      error instanceof NonRetryableJobError || job.attempts >= job.maxAttempts;
    const delayMs = fullJitterBackoff(job.attempts, {
      baseMs: 1_000,
      maxMs: 15 * 60_000,
    });
    this.logger.warn(
      `job ${job.type}/${job.id} attempt ${job.attempts} failed${dead ? ' → DEAD' : ''}: ${error.message}`,
    );
    this.outcomes.add(1, { type: job.type, outcome: dead ? 'dead' : 'retry' });

    await this.sequelize.query(
      `UPDATE "Job" SET
         status = :status,
         "runAt" = CASE WHEN :dead THEN "runAt" ELSE now() + (:delayMs || ' milliseconds')::interval END,
         "finishedAt" = CASE WHEN :dead THEN now() ELSE NULL END,
         "lockedBy" = NULL, "lockedUntil" = NULL, "lastError" = :lastError
       WHERE id = :id AND "createdAt" = :createdAt AND "lockedBy" = :workerId`,
      {
        replacements: {
          status: dead ? 'DEAD' : 'QUEUED',
          dead,
          delayMs,
          lastError: error.message.slice(0, 2_000),
          id: job.id,
          createdAt: job.createdAt,
          workerId: this.workerId,
        },
      },
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopDone;
    // Let in-flight jobs finish; signal long ones to checkpoint and stop.
    const drained = Promise.allSettled([...this.inFlight.values()]);
    const timeout = sleep(20_000).then(() =>
      this.abort.abort(new Error('worker shutting down')),
    );
    await Promise.race([drained, timeout]);
  }
}
