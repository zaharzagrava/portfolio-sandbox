import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const UsageRecorded = defineEvent(
  'usage.recorded',
  'usage',
  1,
  z.object({
    metric: z.string(),
    quantity: z.number().int().positive(),
    ts: z.string(),
  }),
);

/**
 * Metered usage (SD-24): API calls, assistant tokens. Recording is a
 * fire-and-forget Kafka produce keyed by subject (no OLTP write per API call);
 * the projector lands it in ClickHouse. Billing reads exact, de-duplicated
 * sums with FINAL; events that arrive after an invoice locked its period are
 * billed as adjustments on the next invoice.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly producer: KafkaProducerService,
    private readonly clickhouse: ClickHouseService,
  ) {}

  async record(
    subjectId: string,
    metric: string,
    quantity: number,
    eventId: string = uuidv7(),
  ): Promise<void> {
    const event = {
      ...UsageRecorded.create(subjectId, 0, {
        metric,
        quantity,
        ts: new Date().toISOString(),
      }),
      eventId,
    };
    await this.producer
      .send({ topic: UsageRecorded.topic, key: subjectId, value: event })
      .catch((e) => this.logger.warn(`usage dropped: ${e.message}`));
  }

  async totalFor(
    subjectId: string,
    metric: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    const [row] = await this.clickhouse.query<{ total: string }>(
      `SELECT sum(quantity) AS total FROM usage_events FINAL
       WHERE subject_id = {subject:String} AND metric = {metric:String} AND ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)}`,
      {
        subject: subjectId,
        metric,
        from: from.toISOString().replace('Z', ''),
        to: to.toISOString().replace('Z', ''),
      },
    );
    return Number(row?.total ?? 0);
  }

  /** Usage for a closed period that was ingested after the invoice measured it (late events). */
  async lateFor(
    subjectId: string,
    metric: string,
    periodStart: Date,
    periodEnd: Date,
    measuredAt: Date,
  ): Promise<number> {
    const [row] = await this.clickhouse.query<{ total: string }>(
      `SELECT sum(quantity) AS total FROM usage_events FINAL
       WHERE subject_id = {subject:String} AND metric = {metric:String}
         AND ts >= {from:DateTime64(3)} AND ts < {to:DateTime64(3)} AND ingested_at > {measured:DateTime64(3)}`,
      {
        subject: subjectId,
        metric,
        from: periodStart.toISOString().replace('Z', ''),
        to: periodEnd.toISOString().replace('Z', ''),
        measured: measuredAt.toISOString().replace('Z', ''),
      },
    );
    return Number(row?.total ?? 0);
  }
}
