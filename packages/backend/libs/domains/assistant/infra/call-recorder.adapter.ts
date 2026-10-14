import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { LlmCallCompleted } from '../application/events/assistant-events';
import type { CallRecord, CallRecorder } from '../domain/ports';
import { costMicros } from './llm/pricing';

/**
 * INTERIM adapter (S47 R-2): publishes `llm.call_completed` (purpose `rag`, metric `llm.rag.tokens`) for every attempted
 * model call, failed, refused and aborted ones included. It does NOT call `UsageService`: billing (S18) consumes the
 * event. S46's `LlmCallRecorder` replaces this one file. Metering never fails a user-facing call.
 */
@Injectable()
export class CallRecorderAdapter implements CallRecorder {
  private readonly logger = new Logger(CallRecorderAdapter.name);

  constructor(private readonly producer: KafkaProducerService) {}

  async record(call: CallRecord): Promise<void> {
    const model = call.model ?? call.requestedModel;
    const event = LlmCallCompleted.create(call.callId, 0, {
      userId: call.subjectId,
      conversationId: call.scopeId,
      messageId: call.callId,
      purpose: 'rag',
      requestedModel: call.requestedModel,
      model,
      ttftMs: call.ttftMs,
      durationMs: call.durationMs,
      ...call.usage,
      costMicros: costMicros(model, call.usage),
      stopReason: call.stopReason,
      toolCalls: 0,
      scopeId: call.scopeId,
      metric: 'llm.rag.tokens',
      outcome: call.outcome,
      usageEstimated: call.usageEstimated,
    });
    await this.producer
      .send({
        topic: LlmCallCompleted.topic,
        key: call.subjectId,
        value: event,
      })
      .catch((e) => this.logger.warn(`llm metrics dropped: ${e.message}`));
  }
}
