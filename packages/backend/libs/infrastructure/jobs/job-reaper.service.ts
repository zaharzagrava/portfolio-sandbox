import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { randomInt } from 'node:crypto';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { jobMetrics } from './job-metrics';
import { nextStatus, sourceStatus } from './job-state';

const BATCH = 500;
const MARKER = ' [lease expired]';

/**
 * Finds RUNNING jobs whose lease ran out (the worker died or hung) and returns them to the queue with the retry backoff,
 * or ends them DEAD when no attempt is left - so a job that kills every worker that touches it stops after
 * `maxAttempts` (R-05). One statement with `FOR UPDATE SKIP LOCKED`: two reapers at once split the rows, each job is
 * reaped once. `attempts` is not changed here (the claim already counted the lost run).
 */
@Injectable()
export class JobReaper {
  private readonly logger = new Logger(JobReaper.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /**
   * One pass over at most 500 expired jobs. `seed` drives the retry jitter (a hash of job id and seed), so a spec can fix
   * it; production draws a fresh one per pass.
   */
  async reap(seed = randomInt(0, 2 ** 31 - 1)): Promise<number> {
    const now = this.clock.now();
    const reaped = await this.sequelize.query<{ type: string; status: string }>(
      `WITH expired AS (
         SELECT id, "createdAt" FROM "Job"
         WHERE status = :from AND "lockedUntil" < :now
         ORDER BY "lockedUntil" LIMIT :batch FOR UPDATE SKIP LOCKED
       )
       UPDATE "Job" j SET
         status = CASE WHEN j.attempts >= j."maxAttempts" THEN 'DEAD' ELSE :requeued END,
         "runAt" = CASE WHEN j.attempts >= j."maxAttempts" THEN j."runAt" ELSE
           CAST(:now AS timestamptz) + (
             -- full jitter: a deterministic fraction (job id, attempt, seed) of min(15 min, 1 s * 2^attempts)
             (abs(hashtextextended(j.id::text || ':' || j.attempts, :seed)) % 1000000) / 1000000.0
             * least(900000, 1000 * power(2, least(j.attempts, 20)))
           ) * interval '1 millisecond' END,
         "finishedAt" = CASE WHEN j.attempts >= j."maxAttempts" THEN CAST(:now AS timestamptz) ELSE NULL END,
         "lockedBy" = NULL, "lockedUntil" = NULL,
         -- replace, never append: a job that keeps dying carries one marker
         "lastError" = ltrim(regexp_replace(coalesce(j."lastError", ''), '\\s*(\\[lease expired\\]\\s*)+$', '') || :marker)
       FROM expired
       WHERE j.id = expired.id AND j."createdAt" = expired."createdAt" AND j.status = :from
       RETURNING j.type, j.status`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          now,
          seed,
          batch: BATCH,
          marker: MARKER,
          from: sourceStatus('reap'),
          requeued: nextStatus('RUNNING', 'reap'),
        },
      },
    );
    for (const { type } of reaped) jobMetrics.leaseExpired.add(1, { type });
    if (reaped.length > 0)
      this.logger.warn(
        `reaped ${reaped.length} jobs with expired leases (${reaped.filter((r) => r.status === 'DEAD').length} dead)`,
      );
    return reaped.length;
  }
}
