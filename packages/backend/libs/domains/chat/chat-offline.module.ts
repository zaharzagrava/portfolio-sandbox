import { Module } from '@nestjs/common';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { ChatOfflineCheckService } from './application/chat-offline-check.service';
import { CHAT_AGGREGATE } from './application/events/chat-events';
import { ChatCoreModule } from './chat-core.module';
import { PORTS } from './domain/ports';
import { RedisCoalescingSlot } from './infra/coalescing-slot';
import { EscalationFactsAdapter } from './infra/escalation-facts.adapter';
import { OutboxEscalationAdapter } from './infra/escalation-outbox.adapter';

/**
 * The offline check and its adapters (S24 US6), without a queue consumer: `ChatOfflineWorkerModule` adds the consumer
 * for `apps/worker`; the e2e specs load this module and call the check directly. Registers the `chat` aggregate (once
 * per app: the worker; the projector registers it through `ChatProjectorModule`).
 */
@Module({
  imports: [
    ChatCoreModule,
    SqsModule,
    EventsModule.forAggregates([CHAT_AGGREGATE]),
  ],
  providers: [
    RedisCoalescingSlot,
    { provide: PORTS.CoalescingSlot, useExisting: RedisCoalescingSlot },
    { provide: PORTS.EscalationFactsPort, useClass: EscalationFactsAdapter },
    { provide: PORTS.EscalationOutbox, useClass: OutboxEscalationAdapter },
    ChatOfflineCheckService,
  ],
  exports: [ChatOfflineCheckService],
})
export class ChatOfflineModule {}
