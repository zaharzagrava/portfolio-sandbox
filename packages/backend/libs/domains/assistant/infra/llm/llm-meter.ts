import { Injectable, Logger } from '@nestjs/common';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { UsageService } from '@app/domains/billing';
import { LlmCallCompleted } from '../../application/events/assistant-events';
import type { LlmTurnResult } from './llm-provider';
import { costMicros, quotaTokens } from './pricing';

export interface LlmCallRecord {
  /** Billable subject (user or shop); null for anonymous calls (observability only). */
  subjectId: string | null;
  /** Conversation / product / document the call belongs to. */
  scopeId: string;
  callId: string;
  purpose: 'chat' | 'summary' | 'rag' | 'extraction';
  requestedModel: string;
  result: LlmTurnResult;
  ttftMs: number | null;
  durationMs: number;
}

/**
 * One place that turns a model call into (a) billable usage
 * (`usage.recorded` → ClickHouse usage_events) and (b) an observability row
 * (`llm.call_completed` → llm_requests). Fire-and-forget: metering never
 * fails a user-facing call.
 */
@Injectable()
export class LlmMeter {
  private readonly logger = new Logger(LlmMeter.name);

  constructor(
    private readonly producer: KafkaProducerService,
    private readonly usage: UsageService,
  ) {}

  async record(call: LlmCallRecord): Promise<{ tokens: number; costMicros: number }> {
    const tokens = quotaTokens(call.result.usage);
    const cost = costMicros(call.result.model, call.result.usage);
    const event = LlmCallCompleted.create(call.callId, 0, {
      userId: call.subjectId ?? 'anonymous',
      conversationId: call.scopeId,
      messageId: call.callId,
      purpose: call.purpose,
      requestedModel: call.requestedModel,
      model: call.result.model,
      ttftMs: call.ttftMs,
      durationMs: call.durationMs,
      ...call.result.usage,
      costMicros: cost,
      stopReason: call.result.stopReason ?? 'unknown',
      toolCalls: call.result.content.filter((b) => b.type === 'tool_use').length,
    });
    await Promise.all([
      call.subjectId ? this.usage.record(call.subjectId, `llm.${call.purpose}.tokens`, Math.max(1, tokens), event.eventId) : undefined,
      this.producer.send({ topic: LlmCallCompleted.topic, key: call.subjectId ?? call.scopeId, value: event }).catch((e) => this.logger.warn(`llm metrics dropped: ${e.message}`)),
    ]);
    return { tokens, costMicros: cost };
  }
}
