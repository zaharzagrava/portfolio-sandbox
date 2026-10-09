import {
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { StorageModule } from '@app/infrastructure/storage/storage.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ApiConfigService } from '@app/common/config';
import { UsageService } from '@app/domains/billing';
import { LlmModule } from './infra/llm/llm.module';
import { LlmMeter } from './infra/llm/llm-meter';
import { Embedder, HashingEmbedder, VoyageEmbedder } from './infra/embedder';
import {
  INGEST_QUEUE,
  KnowledgeService,
} from './application/knowledge.service';
import { Retriever } from './infra/retriever';
import { AnswerService } from './application/answer.service';
import { KnowledgeController } from './api/knowledge.controller';

const embedderProvider = {
  provide: Embedder,
  inject: [ApiConfigService],
  // No VOYAGE_API_KEY → deterministic hashing embedder (local dev, e2e).
  useFactory: (config: ApiConfigService) => {
    const key = config.get('voyage_api_key');
    return key
      ? new VoyageEmbedder(key, config.get('voyage_model') ?? 'voyage-3.5')
      : new HashingEmbedder();
  },
};

@Module({
  imports: [StorageModule, SqsModule],
  providers: [embedderProvider, KnowledgeService],
  exports: [embedderProvider, KnowledgeService],
})
export class KnowledgeCoreModule {}

/** SD-43 (core): document management + cited answers. */
@Module({
  imports: [
    AuthModule,
    KnowledgeCoreModule,
    LlmModule,
    RateLimitModule,
    KafkaProducerModule,
    ClickHouseModule,
  ],
  providers: [Retriever, AnswerService, LlmMeter, UsageService],
  exports: [Retriever],
  controllers: [KnowledgeController],
})
export class KnowledgeModule {}

@Injectable()
class KnowledgeIngestWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly knowledge: KnowledgeService,
  ) {}

  onApplicationBootstrap() {
    // Concurrency is the embedding provider's rate limit in disguise: N docs × 128-chunk batches.
    this.stop = this.queue.consume<{ documentId: string }>(
      INGEST_QUEUE,
      async ({ body }) => this.knowledge.ingest(body.documentId),
      { concurrency: 4, visibilityTimeoutSec: 300 },
    );
  }

  async onModuleDestroy() {
    await this.stop?.();
  }
}

/** SD-43 (worker): SQS consumer that parses, chunks, embeds and indexes documents. */
@Module({
  imports: [KnowledgeCoreModule, SqsModule],
  providers: [KnowledgeIngestWorker],
})
export class KnowledgeWorkerModule {}
