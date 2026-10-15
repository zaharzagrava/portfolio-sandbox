import { Module } from '@nestjs/common';
import { AuthModule } from '@app/domains/identity';
import { BillingModule } from '@app/domains/billing';
import { ProductModule } from '@app/domains/catalog';
import { ProductSearchModule } from '@app/domains/discovery';
import { PickupModule } from '@app/domains/fulfilment';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit';
import { LlmModule } from '@app/infrastructure/llm';
import { CLOCK } from '@app/common/core/clock';
import { assistantRatePolicies } from './rate-limit-policies';
import {
  ADMISSION_STORE,
  ASSISTANT_CLOCK,
  CONVERSATION_REPOSITORY,
  GENERATION_STORE,
  MODERATION_PORT,
  QUOTA_COUNTER,
  TOOL_CATALOG,
} from './domain/assistant-ports';
import { AssistantController } from './api/assistant.controller';
import { AssistantStreamer } from './api/assistant-stream';
import { AllowanceService } from './application/allowance.service';
import { AssistantToolCatalog } from './application/assistant-tools';
import { AssistantTurnService } from './application/assistant-turn.service';
import { ConversationService } from './application/conversation.service';
import { GenerationService } from './application/generation.service';
import { MeteringService } from './application/metering.service';
import { ModelRouter } from './application/model-router';
import { TurnRunner } from './application/turn-runner';
import { AssistantModerationAdapter } from './infra/moderation.adapter';
import {
  MODERATION_BACKEND,
  ModeratorAdapter,
} from './infra/moderator.adapter';
import { RedisAdmissionAdapter } from './infra/redis-admission.adapter';
import { RedisGenerationStore } from './infra/redis-generation.store';
import { RedisQuotaCounter } from './infra/redis-quota.counter';
import { ScyllaConversationRepository } from './infra/scylla-conversation.repository';

/**
 * SD-42 / S46 shopping assistant (sse-gateway: thousands of held-open streams, I/O bound). Domain code talks to the
 * ports of `domain/assistant-ports.ts`; the Redis, Scylla and moderation adapters are bound here. The other domains are
 * reached only through their exported services (search, products by id, pickup near me, entitlements).
 */
@Module({
  imports: [
    AuthModule,
    LlmModule,
    CassandraModule,
    BillingModule,
    RateLimitModule.forFeature(assistantRatePolicies),
    ProductSearchModule,
    ProductModule,
    PickupModule,
  ],
  providers: [
    { provide: ASSISTANT_CLOCK, useExisting: CLOCK },
    RedisGenerationStore,
    { provide: GENERATION_STORE, useExisting: RedisGenerationStore },
    ScyllaConversationRepository,
    {
      provide: CONVERSATION_REPOSITORY,
      useExisting: ScyllaConversationRepository,
    },
    RedisAdmissionAdapter,
    { provide: ADMISSION_STORE, useExisting: RedisAdmissionAdapter },
    RedisQuotaCounter,
    { provide: QUOTA_COUNTER, useExisting: RedisQuotaCounter },
    // The categorical moderation backend is bound by the deployment; none = the rule-based sensitive-data check only.
    { provide: MODERATION_BACKEND, useValue: null },
    ModeratorAdapter,
    AssistantModerationAdapter,
    { provide: MODERATION_PORT, useExisting: AssistantModerationAdapter },
    AssistantToolCatalog,
    { provide: TOOL_CATALOG, useExisting: AssistantToolCatalog },
    AllowanceService,
    MeteringService,
    ModelRouter,
    TurnRunner,
    GenerationService,
    ConversationService,
    AssistantTurnService,
    AssistantStreamer,
  ],
  controllers: [AssistantController],
})
export class AssistantModule {}
