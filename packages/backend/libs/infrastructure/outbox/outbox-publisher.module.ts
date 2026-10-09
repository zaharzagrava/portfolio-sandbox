import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { DbUtilsModule } from '@app/infrastructure/database/db-utils/db-utils.module';
import Outbox from './outbox.model';
import { OutboxPublisherService } from './outbox-publisher.service';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { CronModule } from '@app/infrastructure/jobs/cron-module/cron.module';
import { ApiConfigModule } from '@app/common/config';

/**
 * Separate from OutboxModule deliberately: OutboxService (writing rows) is
 * needed wherever payments/products are written (payment-processor, core).
 * OutboxPublisherService (the cron-driven mailman draining rows to Kafka) has
 * no Stripe-latency reason to live in payment-processor — it's cheap polling
 * against your own Postgres/Kafka, so it belongs in core with everything else
 * that has no distinguishing resource profile.
 */
@Module({
  imports: [
    SequelizeModule.forFeature([Outbox]),
    DbUtilsModule,
    KafkaProducerModule,
    CronModule,
    ApiConfigModule,
  ],
  providers: [OutboxPublisherService],
})
export class OutboxPublisherModule {}
