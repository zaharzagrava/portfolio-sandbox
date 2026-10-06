import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import Outbox from './outbox.model';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { CronService } from '@app/infrastructure/jobs/cron-module/cron.service';
import { ApiConfigService } from '@app/common/config/api-config.service';

const BATCH_SIZE = 50;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;

const LEASE_MS = 30_000;

interface DueRow {
  id: string;
  topic: string;
  payload: any;
  extra: any;
  error: any;
  attempts: number;
  aggregateId: string | null;
  createdAt: Date;
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit {
  private readonly l = new Logger(OutboxPublisherService.name);

  constructor(
    @InjectModel(Outbox) private readonly outboxModel: typeof Outbox,
    private readonly dbUtilsService: DbUtilsService,
    private readonly kafkaProducerService: KafkaProducerService,
    private readonly cronService: CronService,
    private readonly configService: ApiConfigService,
  ) {}

  onModuleInit() {
    // With Debezium streaming the WAL (infra/debezium), polling would double-publish.
    if (this.configService.get('outbox_relay') === 'cdc') {
      this.l.log('OUTBOX_RELAY=cdc - poller disabled, Debezium relays the outbox');
      return;
    }

    this.cronService.add(
      { cronTime: '*/2 * * * * *' },
      () => this.drain(),
      'outbox-publisher',
    );
  }

  /**
   * Claim-then-publish with a lease (F-05, DOUBTS Q14). The claim pushes
   * `nextAttemptAt` forward by LEASE_MS in the same statement that selects the
   * rows (`FOR UPDATE SKIP LOCKED` inside the UPDATE), so once the claim
   * commits, other pollers can't see these rows until the lease expires -
   * unlike a SELECT whose row locks vanish when its transaction commits,
   * *before* the Kafka publish. A crashed poller's rows reappear after the lease.
   */
  public async drain(): Promise<void> {
    const [rows] = await this.outboxModel.sequelize!.query(
      `UPDATE "Outbox" SET "nextAttemptAt" = NOW() + (:leaseMs || ' milliseconds')::interval
       WHERE id IN (
         SELECT id FROM "Outbox"
         WHERE "publishedAt" IS NULL AND "nextAttemptAt" <= NOW()
         ORDER BY "createdAt"
         LIMIT :limit
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, topic, payload, extra, error, attempts, "aggregateId", "createdAt"`,
      { replacements: { limit: BATCH_SIZE, leaseMs: LEASE_MS } },
    );

    // Keep per-key order within the batch: RETURNING order is unspecified.
    const dueRows = (rows as unknown as DueRow[]).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    for (const row of dueRows) {
      await this.publishOne(row);
    }
  }

  private async publishOne(row: DueRow): Promise<void> {
    // Domain events are keyed by aggregate (per-aggregate ordering); legacy payment rows by idempotency key.
    const key =
      row.aggregateId ?? row.payload?.idempotency_key ?? row.payload?.idempotencyKey ?? row.id;

    try {
      await this.kafkaProducerService.send({
        topic: row.topic,
        key,
        value: { payload: row.payload, extra: row.extra, error: row.error },
      });

      await this.outboxModel.sequelize!.query(
        `UPDATE "Outbox" SET "publishedAt" = NOW() WHERE id = :id`,
        { replacements: { id: row.id } },
      );
    } catch (err) {
      this.l.warn(
        `Failed to publish outbox row ${row.id} to topic ${row.topic}: ${(err as Error).message}`,
      );

      // Exponential in the number of failed attempts (was a constant 2 ** 0), capped.
      const backoffMs = Math.min(BASE_BACKOFF_MS * 2 ** row.attempts, MAX_BACKOFF_MS);
      const jitterMs = Math.floor(Math.random() * 500);

      await this.outboxModel.sequelize!.query(
        `UPDATE "Outbox"
         SET attempts = attempts + 1,
             "nextAttemptAt" = NOW() + (:delayMs || ' milliseconds')::interval
         WHERE id = :id`,
        { replacements: { id: row.id, delayMs: backoffMs + jitterMs } },
      );
    }
  }
}
