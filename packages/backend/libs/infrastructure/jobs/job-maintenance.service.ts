import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { JobHandler } from './job-handler.decorator';
import { JobPayloads } from './job-types';
import { nextFireAt } from './cron';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';
import { sleep } from '@app/common/core/backoff';
import { metrics } from '@opentelemetry/api';

const TICK_MS = 1_000;
/** Arbitrary constant: the advisory-lock key "cron materializer leader". */
const CRON_LOCK_KEY = 7_300_501;

/**
 * Background duties of the jobs subsystem:
 *  - CronMaterializer: due JobSchedules → jobs. Guarded by a transaction-scoped
 *    advisory lock so only one instance materializes per tick (never cron in
 *    every replica, lesson 10/09 #29), and by idempotency keys
 *    `cron:<name>:<fireAt>` so even a double run creates one job.
 *  - Reaper: RUNNING jobs whose lease expired (worker died) → QUEUED.
 *  - Partition maintenance job: create partitions ahead, drop old finished ones.
 */
@Injectable()
export class JobMaintenance implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobMaintenance.name);
  private running = false;
  private loopDone?: Promise<void>;
  private queueLagSeconds = 0;
  private ticks = 0;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({ name: 'jobs.maintenance.stop', order: 10, run: () => this.stop() });

    // The autoscaling signal for the worker fleet (O-03): how late is the oldest due job?
    metrics
      .getMeter('jobs')
      .createObservableGauge('job_queue_lag_seconds', { description: 'now - runAt of the oldest due QUEUED job' })
      .addCallback((result) => result.observe(this.queueLagSeconds));
  }

  onApplicationBootstrap() {
    this.running = true;
    this.loopDone = this.loop();
  }

  private async loop() {
    while (this.running) {
      try {
        await this.materializeDueSchedules();
        await this.reapExpiredLeases();
        if (this.ticks++ % 10 === 0) this.queueLagSeconds = await this.measureQueueLag();
      } catch (error) {
        this.logger.error(`maintenance tick: ${(error as Error).message}`);
      }
      await sleep(TICK_MS);
    }
  }

  async materializeDueSchedules(now = new Date()): Promise<number> {
    return this.sequelize.transaction(async (tx) => {
      const [{ locked }] = await this.sequelize.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(:key) AS locked', {
        type: QueryTypes.SELECT,
        replacements: { key: CRON_LOCK_KEY },
        transaction: tx,
      });
      if (!locked) return 0;

      const due = await this.sequelize.query<{ id: string; name: string; cron: string; timezone: string; jobType: string; payload: unknown; nextFireAt: Date }>(
        `SELECT id, name, cron, timezone, "jobType", payload, "nextFireAt" FROM "JobSchedule"
         WHERE enabled AND "nextFireAt" <= :now ORDER BY "nextFireAt" LIMIT 500 FOR UPDATE`,
        { type: QueryTypes.SELECT, replacements: { now }, transaction: tx },
      );

      for (const schedule of due) {
        const fireAt = new Date(schedule.nextFireAt);
        const key = `cron:${schedule.name}:${fireAt.toISOString()}`;
        await this.sequelize.query(
          `WITH key AS (
             INSERT INTO "JobKey" ("idempotencyKey", "jobId") VALUES (:key, uuidv7())
             ON CONFLICT DO NOTHING RETURNING "jobId"
           )
           INSERT INTO "Job" (id, type, payload, "runAt", "idempotencyKey")
           SELECT "jobId", :type, CAST(:payload AS JSONB), :fireAt, :key FROM key`,
          {
            replacements: { key, type: schedule.jobType, payload: JSON.stringify(schedule.payload), fireAt },
            transaction: tx,
          },
        );
        // Missed fires while down are collapsed to one: next fire is computed from *now*, not from the old fireAt.
        await this.sequelize.query(
          `UPDATE "JobSchedule" SET "lastFiredAt" = :fireAt, "nextFireAt" = :next, "updatedAt" = now() WHERE id = :id`,
          {
            replacements: { id: schedule.id, fireAt, next: nextFireAt(schedule.cron, schedule.timezone, now > fireAt ? now : fireAt) },
            transaction: tx,
          },
        );
      }
      return due.length;
    });
  }

  async reapExpiredLeases(): Promise<number> {
    const [, meta] = await this.sequelize.query(
      `UPDATE "Job" SET status = 'QUEUED', "lockedBy" = NULL, "lockedUntil" = NULL,
              "lastError" = coalesce("lastError", '') || ' [lease expired]'
       WHERE status = 'RUNNING' AND "lockedUntil" < now()`,
    );
    const reaped = (meta as { rowCount?: number })?.rowCount ?? 0;
    if (reaped) this.logger.warn(`reaped ${reaped} jobs with expired leases`);
    return reaped;
  }

  async measureQueueLag(): Promise<number> {
    const [{ lag }] = await this.sequelize.query<{ lag: number | null }>(
      `SELECT extract(epoch FROM now() - min("runAt"))::float AS lag FROM "Job" WHERE status = 'QUEUED' AND "runAt" <= now()`,
      { type: QueryTypes.SELECT },
    );
    return lag ?? 0;
  }

  @JobHandler('jobs.noop', { concurrency: 200 })
  async noop(): Promise<void> {}

  @JobHandler('jobs.partition-maintenance', { concurrency: 1 })
  async maintainPartitions({ aheadDays = 14, retainDays = 30 }: JobPayloads['jobs.partition-maintenance']): Promise<void> {
    await this.sequelize.query(`SELECT job_ensure_partitions(now()::date, :aheadDays)`, { replacements: { aheadDays } });

    // Drop daily partitions older than retainDays that hold no unfinished jobs (far-future
    // schedules may still sit in an old createdAt partition - those are kept until done).
    const old = await this.sequelize.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'Job' AND c.relname ~ '^Job_[0-9]{8}$'
         AND to_date(substr(c.relname, 5), 'YYYYMMDD') < now()::date - :retainDays`,
      { type: QueryTypes.SELECT, replacements: { retainDays } },
    );
    for (const { name } of old) {
      const [{ pending }] = await this.sequelize.query<{ pending: number }>(
        `SELECT count(*)::int AS pending FROM "${name}" WHERE status IN ('QUEUED','RUNNING')`,
        { type: QueryTypes.SELECT },
      );
      if (pending === 0) {
        await this.sequelize.query(`DROP TABLE "${name}"`);
        this.logger.log(`dropped partition ${name}`);
      }
    }
  }

  async stop() {
    this.running = false;
    await this.loopDone;
  }
}
