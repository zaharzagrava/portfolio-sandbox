import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { DateTime } from 'luxon';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { boardKey, boardsKey, revenueKey } from './leaderboard-keys';
import { periodOf, PeriodKind } from '../domain/periods';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'leaderboards.snapshot': { kind?: PeriodKind; periodId?: string };
  }
}

const SNAPSHOT_TOP = 100;

/**
 * After a period closes (plus an hour of grace for late events), the top 100
 * of every board is frozen into Postgres. Re-running replaces the snapshot
 * (DELETE + INSERT in one transaction) - idempotent.
 */
@Injectable()
export class LeaderboardSnapshotJobs implements OnApplicationBootstrap {
  constructor(
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'leaderboards.snapshot-week',
      cron: '0 1 * * 1',
      jobType: 'leaderboards.snapshot',
      payload: { kind: 'week' },
    });
    await this.jobs.upsertSchedule({
      name: 'leaderboards.snapshot-month',
      cron: '0 1 1 * *',
      jobType: 'leaderboards.snapshot',
      payload: { kind: 'month' },
    });
  }

  @JobHandler('leaderboards.snapshot', { concurrency: 1 })
  async snapshot({
    kind = 'week',
    periodId,
  }: {
    kind?: PeriodKind;
    periodId?: string;
  }): Promise<number> {
    const id =
      periodId ??
      periodOf(
        kind,
        DateTime.utc()
          .minus(kind === 'week' ? { weeks: 1 } : { months: 1 })
          .toJSDate(),
      ).id;
    let rows = 0;
    const boards = await this.redis.client.smembers(boardsKey(id));

    for (const board of boards) {
      const ids = await this.redis.client.zrevrange(
        boardKey(id, board),
        0,
        SNAPSHOT_TOP - 1,
      );
      if (ids.length === 0) continue;
      const revenues = await this.redis.client.hmget(
        revenueKey(id, board),
        ...ids,
      );
      // S54 T037 audit: explicit unit of work, opens its own transaction by design; no network I/O inside.
      await this.sequelize.transaction(async (transaction) => {
        await this.sequelize.query(
          `DELETE FROM "LeaderboardSnapshot" WHERE period = :id AND board = :board`,
          { replacements: { id, board }, transaction },
        );
        await this.sequelize.query(
          `INSERT INTO "LeaderboardSnapshot" (period, board, rank, "shopId", revenue)
           SELECT :id, :board, r.rank, r.shop, r.revenue FROM unnest(CAST(:ranks AS int[]), CAST(:shops AS uuid[]), CAST(:revenues AS bigint[])) AS r(rank, shop, revenue)`,
          {
            replacements: {
              id,
              board,
              ranks: `{${ids.map((_, i) => i + 1).join(',')}}`,
              shops: `{${ids.join(',')}}`,
              revenues: `{${revenues.map((r) => r ?? 0).join(',')}}`,
            },
            transaction,
          },
        );
      });
      rows += ids.length;
    }
    return rows;
  }
}
