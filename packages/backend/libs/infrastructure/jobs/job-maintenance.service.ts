import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { nextFireAt } from './cron';
import { resolveMaxAttempts } from './enqueue-options';
import { JobHandler } from './job-handler.decorator';
import { jobMetrics } from './job-metrics';
import { JobReaper } from './job-reaper.service';
import { getJobTypeDeclaration, parseJobPayload } from './job-type-registry';
import { JobPayloads } from './job-types';
import { JOBS_WORKER_OPTIONS } from './jobs-worker-options';
import type { JobsWorkerOptions } from './jobs-worker-options';
import './jobs-builtin-types';

const TICK_MS = 1_000;
/** Arbitrary constant: the advisory-lock key "cron materializer leader". */
const CRON_LOCK_KEY = 7_300_501;
const MATERIALISE_BATCH = 500;
const MATERIALISE_STATEMENT_TIMEOUT_MS = 5_000;
/** A schedule that fails this many ticks in a row is disabled with the error recorded (FR-038). */
const MAX_CONSECUTIVE_FAILURES = 5;
const KEY_PURGE_BATCH = 10_000;
const PARTITION_LOCK_TIMEOUT_MS = 5_000;
const DEAD_GAUGE_EVERY_TICKS = 10;

interface DueSchedule {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  jobType: string;
  payload: unknown;
  nextFireAt: Date;
  overlap: 'skip' | 'allow';
  maxAttempts: number | null;
}

/**
 * Background duties of the jobs subsystem:
 *  - CronMaterializer: due JobSchedules → jobs. Guarded by a transaction-scoped
 *    advisory lock so only one instance materializes per tick (never cron in
 *    every replica, lesson 10/09 #29), and by idempotency keys
 *    `cron:<name>:<fireAt>` so even a double run creates one job.
 *    Each schedule runs in its own savepoint: one bad schedule is recorded
 *    (and disabled after 5 ticks) without blocking the others.
 *  - Reaper (JobReaper): RUNNING jobs whose lease expired (worker died) → QUEUED or DEAD.
 *  - Gauges: queue lag per type every tick, dead jobs and the default partition regularly.
 *  - Partition maintenance job: create partitions ahead, drop old finished ones, purge old keys.
 */
@Injectable()
export class JobMaintenance implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobMaintenance.name);
  private draining = false;
  private wake = new AbortController();
  private loopDone?: Promise<void>;
  private ticks = 0;
  private readonly lagTypes = new Set<string>();
  private readonly deadTypes = new Set<string>();

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly reaper: JobReaper,
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
      name: 'jobs-maintenance',
      order: 10,
      run: () => this.stop(),
    });
  }

  onApplicationBootstrap() {
    if (this.options.loops === false) return;
    this.loopDone = this.loop();
  }

  /** Starts the loop; for specs that created the app with `loops: false`. */
  startLoop(): void {
    this.draining = false;
    this.wake = new AbortController();
    this.loopDone ??= this.loop();
  }

  private async loop() {
    let failures = 0;
    while (!this.draining) {
      let delay = TICK_MS;
      try {
        await this.tick();
        failures = 0;
      } catch (error) {
        // The database being away must not stop the loop: back off with jitter and try again (FR-026).
        failures++;
        this.logger.error(`maintenance tick: ${(error as Error).message}`);
        delay = fullJitterBackoff(failures, { baseMs: 500, maxMs: 15_000 });
      }
      await sleep(delay, this.wake.signal).catch(() => undefined);
    }
  }

  /** One pass of every duty; each is independent so a failure in one does not hide the others. */
  async tick(): Promise<void> {
    const errors: unknown[] = [];
    for (const duty of [
      () => this.materializeDueSchedules(),
      () => this.reaper.reap(),
      () => this.publishQueueGauges(),
    ]) {
      try {
        await duty();
      } catch (error) {
        errors.push(error);
      }
    }
    this.ticks++;
    if (errors.length > 0) throw errors[0];
  }

  /**
   * Turns every due schedule into one job. Returns how many schedules were processed (fired or skipped) by this
   * instance; 0 when another instance holds the leader lock.
   */
  async materializeDueSchedules(now = this.clock.now()): Promise<number> {
    return this.transactions.run(
      async (tx) => {
        const [{ locked }] = await this.sequelize.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(:key) AS locked',
          {
            type: QueryTypes.SELECT,
            replacements: { key: CRON_LOCK_KEY },
            transaction: tx,
          },
        );
        jobMetrics.cronLeader.set(locked ? 1 : 0);
        if (!locked) return 0;

        const due = await this.sequelize.query<DueSchedule>(
          `SELECT id, name, cron, timezone, "jobType", payload, "nextFireAt", overlap, "maxAttempts" FROM "JobSchedule"
           WHERE enabled AND "nextFireAt" <= :now ORDER BY "nextFireAt", name LIMIT :batch FOR UPDATE`,
          {
            type: QueryTypes.SELECT,
            replacements: { now, batch: MATERIALISE_BATCH },
            transaction: tx,
          },
        );

        for (const schedule of due) await this.fireIsolated(tx, schedule, now);
        return due.length;
      },
      {
        propagation: 'requires_new',
        statementTimeoutMs: MATERIALISE_STATEMENT_TIMEOUT_MS,
      },
    );
  }

  private async fireIsolated(tx: Transaction, s: DueSchedule, now: Date) {
    const q = (sql: string, replacements: Record<string, unknown> = {}) =>
      this.sequelize.query(sql, { replacements, transaction: tx });
    await q('SAVEPOINT job_schedule_fire');
    try {
      await this.fire(tx, s, now);
      await q('RELEASE SAVEPOINT job_schedule_fire');
    } catch (error) {
      await q('ROLLBACK TO SAVEPOINT job_schedule_fire');
      const message = (error as Error).message.slice(0, 2_000);
      this.logger.error({
        message: 'schedule could not be materialised',
        schedule: s.name,
        error: message,
      });
      await q(
        `UPDATE "JobSchedule" SET "consecutiveFailures" = "consecutiveFailures" + 1, "lastError" = :message,
           enabled = ("consecutiveFailures" + 1 < :max), "updatedAt" = :now
         WHERE id = :id`,
        { id: s.id, message, now, max: MAX_CONSECUTIVE_FAILURES },
      );
    }
  }

  private async fire(tx: Transaction, s: DueSchedule, now: Date) {
    const q = <R extends object>(
      sql: string,
      replacements: Record<string, unknown>,
    ) =>
      this.sequelize.query<R>(sql, {
        type: QueryTypes.SELECT,
        replacements,
        transaction: tx,
      });
    const fireAt = new Date(s.nextFireAt);
    const payload = parseJobPayload(s.jobType, s.payload);
    const advance = () =>
      q(
        `UPDATE "JobSchedule" SET "nextFireAt" = :next, "consecutiveFailures" = 0, "lastError" = NULL, "updatedAt" = :now
         WHERE id = :id`,
        // Missed fires while down collapse to one: the next fire is computed from *now*, not from the old fireAt.
        { id: s.id, next: nextFireAt(s.cron, s.timezone, now), now },
      );

    if (s.overlap === 'skip') {
      const [{ active }] = await q<{ active: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM "Job" WHERE "scheduleName" = :name AND status IN ('QUEUED', 'RUNNING')) AS active`,
        { name: s.name },
      );
      if (active) {
        jobMetrics.cronFiresSkipped.add(1, { schedule: s.name });
        await advance();
        return;
      }
    }

    const key = `cron:${s.name}:${fireAt.toISOString()}`;
    const created = await q<{ id: string }>(
      `WITH key AS (
         INSERT INTO "JobKey" ("idempotencyKey", "jobId", "type") VALUES (:key, uuidv7(), :type)
         ON CONFLICT DO NOTHING RETURNING "jobId"
       )
       INSERT INTO "Job" (id, type, payload, "runAt", "idempotencyKey", "maxAttempts", "scheduleName")
       SELECT "jobId", :type, CAST(:payload AS JSONB), :fireAt, :key, :maxAttempts, :name FROM key
       RETURNING id`,
      {
        key,
        type: s.jobType,
        payload: JSON.stringify(payload),
        fireAt,
        name: s.name,
        maxAttempts: resolveMaxAttempts({
          schedule: s.maxAttempts,
          typeDefault: getJobTypeDeclaration(s.jobType)?.maxAttempts,
        }),
      },
    );
    if (created.length > 0) {
      await q(
        `UPDATE "JobSchedule" SET "lastFiredAt" = :fireAt WHERE id = :id`,
        { id: s.id, fireAt },
      );
      jobMetrics.cronFires.add(1, { schedule: s.name });
    }
    await advance();
  }

  /** Kept for callers and specs that drive the reaper directly. */
  reapExpiredLeases(): Promise<number> {
    return this.reaper.reap();
  }

  /** Gauges of the autoscaling and alerting signals; the lag is measured on every tick, per type (G-35). */
  async publishQueueGauges(now = this.clock.now()): Promise<void> {
    const lag = await this.sequelize.query<{ type: string; lag: number }>(
      `SELECT type, extract(epoch FROM CAST(:now AS timestamptz) - min("runAt"))::float AS lag
       FROM "Job" WHERE status = 'QUEUED' AND "runAt" <= :now GROUP BY type`,
      { type: QueryTypes.SELECT, replacements: { now } },
    );
    const seen = new Set(lag.map((r) => r.type));
    for (const type of this.lagTypes)
      if (!seen.has(type)) jobMetrics.queueLagSeconds.set(0, { type });
    for (const { type, lag: seconds } of lag) {
      jobMetrics.queueLagSeconds.set(Math.max(0, seconds), { type });
      this.lagTypes.add(type);
    }
    jobMetrics.queueLagSeconds.set(Math.max(0, ...lag.map((r) => r.lag)), {});

    if (this.ticks % DEAD_GAUGE_EVERY_TICKS === 0)
      await this.publishDeadGauge();
  }

  async publishDeadGauge(): Promise<void> {
    const dead = await this.sequelize.query<{ type: string; n: number }>(
      `SELECT type, count(*)::int AS n FROM "Job" WHERE status = 'DEAD' GROUP BY type`,
      { type: QueryTypes.SELECT },
    );
    const seen = new Set(dead.map((r) => r.type));
    for (const type of this.deadTypes)
      if (!seen.has(type)) jobMetrics.deadJobs.set(0, { type });
    for (const { type, n } of dead) {
      jobMetrics.deadJobs.set(n, { type });
      this.deadTypes.add(type);
    }
  }

  async measureQueueLag(now = this.clock.now()): Promise<number> {
    const [{ lag }] = await this.sequelize.query<{ lag: number | null }>(
      `SELECT extract(epoch FROM CAST(:now AS timestamptz) - min("runAt"))::float AS lag
       FROM "Job" WHERE status = 'QUEUED' AND "runAt" <= :now`,
      { type: QueryTypes.SELECT, replacements: { now } },
    );
    return Math.max(0, lag ?? 0);
  }

  @JobHandler('jobs.noop', { concurrency: 200 })
  async noop(): Promise<void> {}

  @JobHandler('jobs.partition-maintenance', { concurrency: 1 })
  async maintainPartitions({
    aheadDays = 14,
    retainDays = this.config.get('jobs_retain_days'),
  }: JobPayloads['jobs.partition-maintenance']): Promise<void> {
    const now = this.clock.now();
    // Today plus `aheadDays` further days: a run on day D keeps D .. D+aheadDays, so the next day adds exactly one.
    await this.sequelize.query(
      `SELECT job_ensure_partitions(CAST(:now AS date), :days)`,
      { replacements: { now, days: aheadDays + 1 } },
    );

    // Drop daily partitions older than retainDays that hold no unfinished job and no recently dead one. The function
    // resolves partition names from the catalog and drops each under a 5 s lock timeout (IX.5).
    const dropped = await this.sequelize.query<{ name: string }>(
      `SELECT job_drop_expired_partitions(:retainDays, :lockTimeoutMs, :now) AS name`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          retainDays,
          lockTimeoutMs: PARTITION_LOCK_TIMEOUT_MS,
          now,
        },
      },
    );
    for (const { name } of dropped)
      this.logger.log(`dropped partition ${name}`);

    await this.purgeKeys(retainDays, now);

    const [{ rows }] = await this.sequelize.query<{ rows: string }>(
      `SELECT job_default_partition_rows()::text AS rows`,
      { type: QueryTypes.SELECT },
    );
    jobMetrics.defaultPartitionRows.set(Number(rows));
    if (Number(rows) > 0)
      this.logger.warn(
        `${rows} jobs sit in the default partition: partition maintenance fell behind`,
      );
  }

  /**
   * Removes the idempotency keys of jobs that finished before the retention cutoff, or whose job is gone with its
   * partition, in batches of 10,000 until a short batch (FR-005, FR-048). Returns how many went.
   */
  async purgeKeys(retainDays: number, now = this.clock.now()): Promise<number> {
    const cutoff = new Date(now.getTime() - retainDays * 86_400_000);
    let total = 0;
    for (;;) {
      const removed = await this.sequelize.query<{ idempotencyKey: string }>(
        `DELETE FROM "JobKey" WHERE ctid IN (
           SELECT k.ctid FROM "JobKey" k
           WHERE k."createdAt" < :cutoff
             AND NOT EXISTS (
               SELECT 1 FROM "Job" j WHERE j.id = k."jobId" AND (j."finishedAt" IS NULL OR j."finishedAt" >= :cutoff)
             )
           ORDER BY k."createdAt" LIMIT :batch
         ) RETURNING "idempotencyKey"`,
        {
          type: QueryTypes.SELECT,
          replacements: { cutoff, batch: KEY_PURGE_BATCH },
        },
      );
      total += removed.length;
      if (removed.length < KEY_PURGE_BATCH) return total;
    }
  }

  async stop() {
    this.draining = true;
    this.wake.abort();
    await this.loopDone;
  }
}
