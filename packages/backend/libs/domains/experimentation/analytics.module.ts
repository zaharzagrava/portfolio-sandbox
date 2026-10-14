import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { SequelizeModule } from '@nestjs/sequelize';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { AuthModule } from '@app/domains/identity';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { AssignmentService } from './application/assignment.service';
import { ExperimentCommandService } from './application/experiment-command.service';
import { ExperimentQueryService } from './application/experiment-query.service';
import { ExperimentResultsService } from './application/experiment-results.service';
import { IngestService } from './application/ingest.service';
import { EventsController } from './api/events.controller';
import { ExperimentAssignmentsController } from './api/experiment-assignments.controller';
import { ExperimentsAdminController } from './api/experiments-admin.controller';
import { IngestBodyGuard } from './api/ingest-body.guard';
import { IngestMetricsMiddleware } from './api/ingest-metrics.middleware';
import { EXPERIMENT_PROBLEMS } from './domain/experiment-errors';
import {
  EVENT_PRODUCER,
  EVENT_STORE,
  EXPERIMENT_REPOSITORY,
  RUNNING_SET_CACHE,
} from './domain/ports';
import { CacheRunningSet } from './infra/cache-running-set';
import { ClickHouseEventStore } from './infra/clickhouse-event-store';
import { KafkaEventProducer } from './infra/kafka-event-producer';
import ExperimentAuditModel from './infra/models/experiment-audit.model';
import ExperimentModel from './infra/models/experiment.model';
import { SequelizeExperimentRepository } from './infra/sequelize-experiment.repository';
import { analyticsRatePolicies } from './rate-limit-policies';

/**
 * Analytics and experiments on the core app (S39): the ingest fallback, the assignments endpoint, the experiment admin
 * routes and the results. Adapters sit behind their port tokens (`domain/ports.ts`); the barrel exports this module only.
 */
@Module({
  imports: [
    AuthModule,
    TransactionModule,
    KafkaProducerModule,
    ClickHouseModule,
    CacheModule,
    ClockModule,
    SequelizeModule.forFeature([ExperimentModel, ExperimentAuditModel]),
    ProblemCatalogModule.forFeature(EXPERIMENT_PROBLEMS),
    RateLimitModule.forFeature(analyticsRatePolicies),
  ],
  providers: [
    IngestService,
    AssignmentService,
    ExperimentCommandService,
    ExperimentQueryService,
    ExperimentResultsService,
    IngestBodyGuard,
    KafkaEventProducer,
    { provide: EVENT_PRODUCER, useExisting: KafkaEventProducer },
    ClickHouseEventStore,
    { provide: EVENT_STORE, useExisting: ClickHouseEventStore },
    SequelizeExperimentRepository,
    {
      provide: EXPERIMENT_REPOSITORY,
      useExisting: SequelizeExperimentRepository,
    },
    CacheRunningSet,
    { provide: RUNNING_SET_CACHE, useExisting: CacheRunningSet },
  ],
  controllers: [
    EventsController,
    ExperimentAssignmentsController,
    ExperimentsAdminController,
  ],
})
export class AnalyticsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(IngestMetricsMiddleware)
      .forRoutes({ path: 'events', method: RequestMethod.POST });
  }
}
