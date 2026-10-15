import { Inject, Injectable, Logger } from '@nestjs/common';
import { LlmCallRecorder, type LlmUsage } from '@app/infrastructure/llm';
import {
  ASSISTANT_CLOCK,
  QUOTA_COUNTER,
  type Clock,
  type QuotaCounter,
} from '../domain/assistant-ports';
import { monthKey } from '../domain/month';
import {
  assistantChargeFailures,
  assistantTokens,
  assistantTtft,
} from './assistant-metrics';
import { logIds } from './turn-log';

export interface MeteredTurn {
  userId: string;
  conversationId: string;
  messageId: string;
  requestId?: string;
}

export interface MeteredCall {
  /** Position in the turn (`callId = "<messageId>:<n>"`); the summary is 0. */
  n: number;
  purpose: 'chat' | 'summary';
  requestedModel: string;
  model: string | null;
  outcome: 'completed' | 'refused' | 'aborted' | 'failed';
  usage: LlmUsage;
  stopReason: string | null;
  content?: Parameters<LlmCallRecorder['record']>[0]['result']['content'];
  ttftMs: number | null;
  durationMs: number;
  usageEstimated: boolean;
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/**
 * One durable record and one allowance charge per model call (S46 FR-026, FR-035). The record goes through the outbox
 * (billing consumes it); the charge keeps the admission counter in step and is idempotent by call id. Neither failure
 * fails the turn: the recorder counts and logs a lost record, a failed charge is retried once and counted.
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);

  constructor(
    private readonly recorder: LlmCallRecorder,
    @Inject(QUOTA_COUNTER) private readonly quota: QuotaCounter,
    @Inject(ASSISTANT_CLOCK) private readonly clock: Clock,
  ) {}

  async recordCall(turn: MeteredTurn, call: MeteredCall): Promise<number> {
    const callId = `${turn.messageId}:${call.n}`;
    // Metrics first: they are in memory and must not trail the durable record that a reader may already see.
    const model = call.model ?? call.requestedModel;
    assistantTokens.add(call.usage.inputTokens, { model, kind: 'input' });
    assistantTokens.add(call.usage.outputTokens, { model, kind: 'output' });
    assistantTokens.add(call.usage.cacheReadTokens, {
      model,
      kind: 'cache_read',
    });
    assistantTokens.add(call.usage.cacheWriteTokens, {
      model,
      kind: 'cache_write',
    });
    if (call.ttftMs !== null)
      assistantTtft.record(call.ttftMs / 1000, { model });

    const { billableTokens } = await this.recorder.record({
      subjectId: turn.userId,
      scopeId: turn.conversationId,
      callId,
      messageId: turn.messageId,
      purpose: call.purpose,
      metric: 'llm.assistant.tokens',
      requestedModel: call.requestedModel,
      outcome: call.outcome,
      result: {
        model: call.model,
        usage: call.usage,
        stopReason: call.stopReason,
        content: call.content,
      },
      ttftMs: call.ttftMs,
      durationMs: call.durationMs,
      usageEstimated: call.usageEstimated,
    });

    await this.charge(turn, callId, billableTokens);
    return billableTokens;
  }

  private async charge(turn: MeteredTurn, callId: string, tokens: number) {
    const userId = turn.userId;
    const month = monthKey(this.clock);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.quota.charge(userId, month, callId, tokens);
        return;
      } catch (error) {
        if (attempt === 1) {
          assistantChargeFailures.add(1);
          // Only what is needed to re-apply the charge; no content.
          this.logger.error(
            `allowance charge lost ${logIds({ requestId: turn.requestId, conversationId: turn.conversationId, messageId: turn.messageId, callId })} ${JSON.stringify({ billableTokens: tokens })}`,
          );
        }
      }
    }
  }
}
