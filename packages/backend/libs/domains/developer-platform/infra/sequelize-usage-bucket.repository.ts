import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { UsageRecorded } from '@app/domains/billing';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { InboxService } from '@app/infrastructure/inbox';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { UsageBucketRepository } from '../domain/ports';
import { USAGE_METRIC, usageEventId } from '../domain/usage-bucket';

const CONSUMER = 'public-api.usage-metering';

/** `ApiUsageBucket` (R-08): billable calls per shop and UTC minute, exact under duplicates, restarts and late records. */
@Injectable()
export class SequelizeUsageBucketRepository extends UsageBucketRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly inbox: InboxService,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  async add(input: {
    eventId: string;
    shopId: string;
    minute: Date;
    quantity: number;
  }): Promise<'added' | 'duplicate'> {
    const { eventId, shopId, minute, quantity } = input;
    return this.runner.run(async (tx) => {
      if (!(await this.inbox.recordOnce(CONSUMER, eventId))) return 'duplicate';
      // this shop-minute is changed by one writer at a time, so the next sequence cannot be taken twice
      await this.sequelize.query(
        `SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: { key: `${shopId}|${minute.toISOString()}` },
        },
      );
      const open = await this.sequelize.query(
        `UPDATE "ApiUsageBucket" SET quantity = quantity + :quantity
          WHERE "shopId" = :shopId AND minute = :minute AND "emittedAt" IS NULL RETURNING sequence`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: { shopId, minute, quantity },
        },
      );
      if (open.length === 0)
        await this.sequelize.query(
          `INSERT INTO "ApiUsageBucket" ("shopId", minute, sequence, quantity)
           SELECT :shopId, :minute, COALESCE(max(sequence), 0) + 1, :quantity
             FROM "ApiUsageBucket" WHERE "shopId" = :shopId AND minute = :minute`,
          { transaction: tx, replacements: { shopId, minute, quantity } },
        );
      return 'added';
    });
  }

  async emitClosed(input: {
    closedBefore: Date;
    limit: number;
    now: Date;
  }): Promise<number> {
    const { closedBefore, limit, now } = input;
    return this.runner.run(async (tx) => {
      const due = await this.sequelize.query<{
        shopId: string;
        minute: Date;
        sequence: number;
        quantity: number;
      }>(
        `SELECT "shopId", minute, sequence, quantity FROM "ApiUsageBucket"
          WHERE "emittedAt" IS NULL AND minute <= :closedBefore
          ORDER BY minute, "shopId", sequence LIMIT :limit FOR UPDATE SKIP LOCKED`,
        {
          type: QueryTypes.SELECT,
          transaction: tx,
          replacements: { closedBefore, limit },
        },
      );
      if (due.length === 0) return 0;
      const events = due.map((b) => {
        const eventId = usageEventId(
          b.shopId,
          USAGE_METRIC,
          new Date(b.minute),
          b.sequence,
        );
        return {
          bucket: b,
          eventId,
          envelope: {
            ...UsageRecorded.create(
              b.shopId,
              b.sequence,
              {
                metric: USAGE_METRIC,
                quantity: b.quantity,
                ts: new Date(b.minute).toISOString(),
              },
              now,
            ),
            eventId,
          },
        };
      });
      for (const e of events)
        await this.sequelize.query(
          `UPDATE "ApiUsageBucket" SET "emittedAt" = :now, "eventId" = :eventId
            WHERE "shopId" = :shopId AND minute = :minute AND sequence = :sequence`,
          {
            transaction: tx,
            replacements: {
              now,
              eventId: e.eventId,
              shopId: e.bucket.shopId,
              minute: e.bucket.minute,
              sequence: e.bucket.sequence,
            },
          },
        );
      await this.outbox.append(
        events.map((e) => e.envelope),
        tx,
      );
      return events.length;
    });
  }
}
