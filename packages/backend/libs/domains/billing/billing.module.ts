import { AuthModule } from '@app/domains/identity';
import { Global, Module } from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import Plan from './infra/models/plan.model';
import Price from './infra/models/price.model';
import Subscription from './infra/models/subscription.model';
import Invoice from './infra/models/invoice.model';
import InvoiceLine from './infra/models/invoice-line.model';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { BillingService } from './application/billing.service';
import { EntitlementsService, ShopEntitlementGuard } from './application/entitlements.service';
import { UsageService } from './application/usage.service';
import { BillingController } from './api/billing.controller';

export const BILLING_MODELS = [Plan, Price, Subscription, Invoice, InvoiceLine];

/**
 * SD-24 (core). Global: other domains read entitlements (`@RequiresShopEntitlement`)
 * and record usage (SD-07 API calls, SD-42 assistant tokens).
 */
@Global()
@Module({
  imports: [AuthModule, JobsModule, KafkaProducerModule, ClickHouseModule, SequelizeModule.forFeature(BILLING_MODELS)],
  providers: [BillingService, EntitlementsService, ShopEntitlementGuard, UsageService],
  exports: [BillingService, EntitlementsService, ShopEntitlementGuard, UsageService],
  controllers: [BillingController],
})
export class BillingModule {}
