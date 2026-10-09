import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { LlmCallCompleted } from '../application/events/assistant-events';

/** `llm.events` → ClickHouse `llm_requests` (SD-42 observability: TTFT, tokens, cost per user/model). */
@Injectable()
export class LlmCallsProjector implements Projector {
  readonly name = 'llm-calls-log';
  readonly topics = [LlmCallCompleted.topic];
  // ClickHouse keeps one row per event_id at merge time.
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: LlmCallCompleted }];
  private readonly sink: ClickHouseSink;

  constructor(clickhouse: ClickHouseService) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    await this.sink.insert(
      'llm_requests',
      events
        .map((e) => LlmCallCompleted.match(e))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map(({ eventId, payload: p, occurredAt }) => ({
          event_id: eventId,
          user_id: p.userId,
          conversation_id: p.conversationId,
          message_id: p.messageId,
          purpose: p.purpose,
          requested_model: p.requestedModel,
          model: p.model,
          ttft_ms: p.ttftMs,
          duration_ms: p.durationMs,
          input_tokens: p.inputTokens,
          output_tokens: p.outputTokens,
          cache_read_tokens: p.cacheReadTokens,
          cache_write_tokens: p.cacheWriteTokens,
          cost_micros: p.costMicros,
          stop_reason: p.stopReason,
          tool_calls: p.toolCalls,
          ts: occurredAt.replace('Z', ''),
        })),
    );
  }
}
