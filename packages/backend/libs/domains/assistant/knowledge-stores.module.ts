import { Module } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import {
  DOCUMENT_REPOSITORY,
  EMBEDDING_PROVIDER,
  OBJECT_STORE,
  PASSAGE_REPOSITORY,
  PDF_PARSER,
  QUESTION_CACHE,
  TASK_PUBLISHER,
} from './domain/ports';
import { HashingEmbedder, VoyageEmbedder } from './infra/embedder';
import { PgDocumentRepository } from './infra/pg-document.repository';
import { PgPassageRepository } from './infra/pg-passage.repository';
import { UnpdfParser } from './infra/pdf-parser';
import { QuestionCacheAdapter } from './infra/question-cache.adapter';
import { StorageAdapter } from './infra/storage.adapter';
import { TaskPublisherAdapter } from './infra/task-publisher.adapter';

const PORTS = [
  DOCUMENT_REPOSITORY,
  PASSAGE_REPOSITORY,
  EMBEDDING_PROVIDER,
  OBJECT_STORE,
  PDF_PARSER,
  TASK_PUBLISHER,
  QUESTION_CACHE,
];

/**
 * The stores and adapters of the knowledge half behind their port tokens (S47 R-1, D-6), shared by the HTTP side, the
 * worker and the projector so there is one copy of each adapter per process. Redis and the database are global
 * modules; a spec replaces a token with a fault-injecting wrapper (`overrideProvider(EMBEDDING_PROVIDER)`).
 *
 * The deterministic hashing embedder is bound only when there is no `voyage_api_key`, and production refuses that
 * (`knowledgeProductionRule` at configuration load, `KnowledgeConfigGuard` at start).
 */
@Module({
  imports: [ClockModule, SqsModule, StorageModule],
  providers: [
    PgDocumentRepository,
    PgPassageRepository,
    UnpdfParser,
    StorageAdapter,
    TaskPublisherAdapter,
    QuestionCacheAdapter,
    { provide: DOCUMENT_REPOSITORY, useExisting: PgDocumentRepository },
    { provide: PASSAGE_REPOSITORY, useExisting: PgPassageRepository },
    { provide: PDF_PARSER, useExisting: UnpdfParser },
    { provide: OBJECT_STORE, useExisting: StorageAdapter },
    { provide: TASK_PUBLISHER, useExisting: TaskPublisherAdapter },
    { provide: QUESTION_CACHE, useExisting: QuestionCacheAdapter },
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => {
        const key = config.get('voyage_api_key');
        return key
          ? new VoyageEmbedder(
              key,
              config.get('voyage_model'),
              config.get('knowledge_embed_batch'),
            )
          : new HashingEmbedder();
      },
    },
  ],
  exports: PORTS,
})
export class KnowledgeStoresModule {}
