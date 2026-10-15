import { Module, type Type } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { ProductModule } from '@app/domains/catalog';
import { TenancyModule } from '@app/domains/tenancy';
import { ProblemCatalogModule } from '@app/common/errors/problem-catalog.module';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { jsonBodyLimits } from '@app/infrastructure/platform/body-limits';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import type { Projector } from '@app/infrastructure/projections/projector';
import { AskService } from './application/ask.service';
import { DocumentService } from './application/document.service';
import { IngestService } from './application/ingest.service';
import { KnowledgeSearchService } from './application/knowledge-search.service';
import { LifecycleService } from './application/lifecycle.service';
import { ReindexService } from './application/reindex.service';
import { SweepService } from './application/sweep.service';
import { KnowledgeAdminController } from './api/knowledge-admin.controller';
import { KnowledgeAskController } from './api/knowledge-ask.controller';
import { KnowledgeDocumentsController } from './api/knowledge-documents.controller';
import { KNOWLEDGE_PROBLEMS } from './domain/knowledge-errors';
import {
  ANSWER_MODEL,
  CALL_RECORDER,
  MODERATOR,
  PRODUCT_DIRECTORY,
  SHOP_DIRECTORY,
} from './domain/ports';
import { AnswerModelAdapter } from './infra/answer-model.adapter';
import { CallRecorderAdapter } from './infra/call-recorder.adapter';
import { CatalogAdapter } from './infra/catalog.adapter';
import { KnowledgeConfigGuard } from './infra/knowledge-config.guard';
import { KnowledgeIngestConsumer } from './infra/knowledge-ingest.consumer';
import {
  KnowledgeProductDeletedConsumer,
  KnowledgeShopDeletedConsumer,
} from './infra/knowledge-lifecycle.projectors';
import { KnowledgeSweepJobs } from './infra/knowledge-sweep.jobs';
import { LlmModule } from '@app/infrastructure/llm';
import {
  MODERATION_BACKEND,
  ModeratorAdapter,
} from './infra/moderator.adapter';
import { TenancyAdapter } from './infra/tenancy.adapter';
import { knowledgeRatePolicies } from './knowledge-rate-limit-policies';
import { KnowledgeStoresModule } from './knowledge-stores.module';

/**
 * Inline markdown may be exactly 1 MiB (S47 FR-001), so the JSON body of a document create is slightly above the
 * platform's default 1 MiB limit: these two routes read up to 2 MiB and the contract schema decides (`400` with the
 * field), instead of the platform answering `413` first. Every other body keeps the default.
 */
jsonBodyLimits.register({
  match: /\/knowledge\/documents\/?$/,
  limit: '2mb',
});

/**
 * The model, the recorder, the moderator and the catalog/tenancy lookups behind their port tokens. The model and the
 * recorder adapters delegate to `@app/infrastructure/llm` (S46); the moderator keeps the backend slot (S47 R-2, R-3).
 */
const ASK_PORTS = [
  { provide: PRODUCT_DIRECTORY, useExisting: CatalogAdapter },
  { provide: SHOP_DIRECTORY, useExisting: TenancyAdapter },
  { provide: ANSWER_MODEL, useExisting: AnswerModelAdapter },
  { provide: CALL_RECORDER, useExisting: CallRecorderAdapter },
  { provide: MODERATOR, useExisting: ModeratorAdapter },
  // The categorical moderation backend S46 will supply; none bound yet (production refuses that, AS-54).
  { provide: MODERATION_BACKEND, useFactory: () => null },
];

/**
 * Hybrid retrieval and nothing else (S47 FR-020 – FR-027): what the evaluation harness boots, and what `KnowledgeModule`
 * uses. Needs the database, Redis and the platform's transaction runner from its host.
 */
@Module({
  imports: [KnowledgeStoresModule, ClockModule],
  providers: [KnowledgeSearchService],
  exports: [KnowledgeSearchService],
})
export class KnowledgeSearchModule {}

/** SD-43 / S47 (apps/core): the documents API, the platform routes and the two ask routes. */
@Module({
  imports: [
    AuthModule,
    ProductModule,
    TenancyModule,
    KnowledgeStoresModule,
    KnowledgeSearchModule,
    LlmModule,
    KafkaProducerModule,
    ClockModule,
    ProblemCatalogModule.forFeature(KNOWLEDGE_PROBLEMS),
    RateLimitModule.forFeature(knowledgeRatePolicies),
  ],
  providers: [
    CatalogAdapter,
    TenancyAdapter,
    AnswerModelAdapter,
    CallRecorderAdapter,
    ModeratorAdapter,
    ...ASK_PORTS,
    DocumentService,
    ReindexService,
    AskService,
    KnowledgeConfigGuard,
  ],
  controllers: [
    KnowledgeDocumentsController,
    KnowledgeAdminController,
    KnowledgeAskController,
  ],
  exports: [KnowledgeSearchModule],
})
export class KnowledgeModule {}

/** SD-43 / S47 (apps/worker): the ingestion consumer and the sweep job. */
@Module({
  imports: [KnowledgeStoresModule, JobsModule, ClockModule],
  providers: [
    IngestService,
    SweepService,
    KnowledgeIngestConsumer,
    KnowledgeSweepJobs,
    KnowledgeConfigGuard,
  ],
})
export class KnowledgeWorkerModule {}

/**
 * S47 (apps/projector): the consumers that delete a product's or a shop's documents. The app lists
 * `KnowledgeProjectorModule.projectors` in `ProjectionsModule.forProjectors` and imports this module for what they
 * inject.
 */
@Module({
  imports: [KnowledgeStoresModule],
  providers: [
    LifecycleService,
    KnowledgeProductDeletedConsumer,
    KnowledgeShopDeletedConsumer,
  ],
  exports: [
    LifecycleService,
    KnowledgeProductDeletedConsumer,
    KnowledgeShopDeletedConsumer,
  ],
})
export class KnowledgeProjectorModule {
  static readonly projectors: Type<Projector>[] = [
    KnowledgeProductDeletedConsumer,
    KnowledgeShopDeletedConsumer,
  ];
}
