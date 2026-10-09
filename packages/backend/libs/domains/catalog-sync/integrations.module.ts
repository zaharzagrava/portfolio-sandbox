import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { PRODUCTS_AGGREGATE } from '@app/domains/catalog';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { IntegrationSyncService } from './application/integration-sync.service';
import { IntegrationsController } from './api/integrations.controller';
import {
  IntegrationWorkers,
  StockPushProjector,
} from './infra/integrations.workers';

const BASE = [
  AuthModule,
  SqsModule,
  RateLimitModule,
  EventsModule.forAggregates([PRODUCTS_AGGREGATE]),
];

/** SD-36 API (core). AuthModule provides SecretBox for sealed credentials. */
@Module({
  imports: BASE,
  providers: [IntegrationSyncService],
  exports: [IntegrationSyncService],
  controllers: [IntegrationsController],
})
export class IntegrationsModule {}

/** SD-36 sync workers (apps/worker). */
@Module({
  imports: [...BASE, JobsModule],
  providers: [IntegrationSyncService, IntegrationWorkers],
})
export class IntegrationsWorkerModule {}

/** SD-36 outbound stock projector deps (apps/projector). */
@Module({
  imports: BASE,
  providers: [IntegrationSyncService],
  exports: [IntegrationSyncService],
})
export class IntegrationsCoreModule {}

export { StockPushProjector };
