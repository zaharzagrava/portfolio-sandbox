import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ProductModule } from '@app/domains/catalog';
import { PickupModule } from '@app/domains/fulfilment';
import { EntitlementsService, UsageService } from '@app/domains/billing';
import { ConversationStore } from './infra/conversation.store';
import { GenerationBuffer } from './infra/generation-buffer';
import { AssistantToolExecutor } from './application/assistant-tools';
import { AssistantQuotaService } from './application/assistant-quota.service';
import { AssistantService } from './application/assistant.service';
import { AssistantStreamer } from './api/assistant-stream';
import { AssistantController } from './api/assistant.controller';
import { LlmModule } from './infra/llm/llm.module';
import { LlmMeter } from './infra/llm/llm-meter';

/** SD-42 (sse-gateway: thousands of held-open streams, I/O bound - the same resource profile as the topic streams). */
@Module({
  imports: [AuthModule, LlmModule, CassandraModule, CacheModule, RateLimitModule, KafkaProducerModule, ClickHouseModule, ProductModule, PickupModule],
  providers: [
    ConversationStore,
    GenerationBuffer,
    AssistantToolExecutor,
    AssistantQuotaService,
    AssistantService,
    AssistantStreamer,
    EntitlementsService,
    UsageService,
    LlmMeter,
  ],
  controllers: [AssistantController],
  exports: [AssistantService],
})
export class AssistantModule {}
