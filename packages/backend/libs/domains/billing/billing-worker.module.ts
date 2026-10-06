import { Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { StripeModule } from '@app/infrastructure/stripe/stripe.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { BillingService } from './application/billing.service';
import { EntitlementsService } from './application/entitlements.service';
import { UsageService } from './application/usage.service';
import { BillingGateway, StripeBillingGateway } from './infra/billing-gateway.port';
import { BillingJobs } from './infra/billing.jobs';
import { BILLING_MODELS } from './billing.module';

/** SD-24 background side (apps/worker): renewals, charges, dunning. */
@Module({
  imports: [JobsModule, EventsModule, StripeModule, KafkaProducerModule, ClickHouseModule, CacheModule, SequelizeModule.forFeature(BILLING_MODELS)],
  providers: [BillingService, EntitlementsService, UsageService, { provide: BillingGateway, useClass: StripeBillingGateway }, BillingJobs],
})
export class BillingWorkerModule {}
