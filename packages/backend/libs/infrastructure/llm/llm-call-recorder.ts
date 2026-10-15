import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { createHash } from 'node:crypto';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { getActiveTransaction } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { billableTokens } from './billable-tokens';
import {
  LLM_OUTCOMES,
  LLM_PURPOSES,
  LlmCallCompleted,
} from './llm-call-completed';
import type { LlmResult, LlmUsage } from './llm-provider';
import { costMicros, isPriced } from './pricing';

/**
 * Deterministic event id: the same `callId` always yields the same `eventId` (consumer-side dedupe). The envelope
 * schema (S53) accepts only UUIDv7, so the id is a hash of the call id laid out as a UUIDv7 (version 7, RFC variant)
 * instead of the UUIDv5 the contract text names; it carries no timestamp, ordering comes from `occurredAt`.
 */
export const eventIdForCall = (callId: string): string => {
  const h = createHash('sha256').update(`llm.call_completed:${callId}`).digest('hex');
  const variant = '89ab'[parseInt(h[16], 16) & 3];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface LlmCallRecord {
  /** Billed subject (user or shop); `anonymous` for calls nobody pays for (observability only). */
  subjectId: string;
  /** Conversation / product / document the call belongs to. */
  scopeId: string;
  /** `<messageId>:<n>` (summary `:0`), S04 `<documentId>:<attempt>`. Unique per model call; the event's aggregate id. */
  callId: string;
  /** Defaults to the `callId` without its `:<n>` suffix. */
  messageId?: string;
  purpose: (typeof LLM_PURPOSES)[number];
  metric: string;
  requestedModel: string;
  outcome: (typeof LLM_OUTCOMES)[number];
  /** What the provider returned. A call that failed before any answer passes zero usage. */
  result: {
    model: string | null;
    usage: LlmUsage;
    stopReason: string | null;
    content?: LlmResult['content'];
  };
  ttftMs: number | null;
  durationMs: number;
  /** True when `result.usage` holds `chars / 4` estimates (aborted or failed mid-stream). */
  usageEstimated?: boolean;
}

export interface LlmCallRecorderOptions {
  retries: number;
  backoffMs: { baseMs: number; maxMs: number };
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const LLM_RECORDER_OPTIONS = Symbol('LLM_RECORDER_OPTIONS');

const DEFAULTS: LlmCallRecorderOptions = {
  retries: 3,
  backoffMs: { baseMs: 100, maxMs: 2_000 },
  sleep,
  random: Math.random,
};

/**
 * The one place that turns a model call into its durable record: appends `llm.call_completed` v1 to the outbox
 * (S18 charges the subject from it, the analytics projector stores it). Joins the caller's transaction when there is
 * one, otherwise uses its own. Metering never fails a user-facing call: an append that keeps failing is retried,
 * then counted and logged with what is needed to re-create the record (AS-71).
 */
@Injectable()
export class LlmCallRecorder {
  private readonly logger = new Logger(LlmCallRecorder.name);
  private readonly failures = metrics
    .getMeter('llm')
    .createCounter('assistant_metering_failures_total');
  private readonly options: LlmCallRecorderOptions;

  constructor(
    private readonly outbox: OutboxService,
    @Optional()
    @Inject(LLM_RECORDER_OPTIONS)
    options?: Partial<LlmCallRecorderOptions>,
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Never throws. Returns what the caller charges to the month counter. */
  async record(
    call: LlmCallRecord,
  ): Promise<{ billableTokens: number; costMicros: number }> {
    const { usage } = call.result;
    const tokens = billableTokens(usage);
    const cost = this.cost(call);
    const model = call.result.model ?? call.requestedModel;
    const messageId = call.messageId ?? call.callId.replace(/:\d+$/, '');
    let event;
    try {
      event = {
        ...LlmCallCompleted.create(call.callId, 0, {
          userId: call.subjectId,
          subjectId: call.subjectId,
          metric: call.metric,
          billableTokens: tokens,
          conversationId: call.scopeId,
          scopeId: call.scopeId,
          messageId,
          callId: call.callId,
          purpose: call.purpose,
          requestedModel: call.requestedModel,
          model,
          outcome: call.outcome,
          ttftMs: call.ttftMs === null ? null : Math.round(call.ttftMs),
          durationMs: Math.max(0, Math.round(call.durationMs)),
          ...usage,
          costMicros: cost,
          usageEstimated: call.usageEstimated ?? false,
          stopReason: call.result.stopReason ?? 'unknown',
          toolCalls: (call.result.content ?? []).filter(
            (b) => b.type === 'tool_use',
          ).length,
        }),
        eventId: eventIdForCall(call.callId),
      };
    } catch (error) {
      this.giveUp(call, tokens, cost, error);
      return { billableTokens: tokens, costMicros: cost };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      try {
        if (getActiveTransaction()) await this.outbox.append(event);
        else await this.outbox.appendStandalone(event);
        return { billableTokens: tokens, costMicros: cost };
      } catch (error) {
        lastError = error;
        if (attempt < this.options.retries)
          await this.options.sleep(
            fullJitterBackoff(
              attempt,
              this.options.backoffMs,
              this.options.random,
            ),
          );
      }
    }
    this.giveUp(call, tokens, cost, lastError);
    return { billableTokens: tokens, costMicros: cost };
  }

  /** The answering model may carry a dated id the table lacks; the requested model prices it, else 0 and a log line. */
  private cost(call: LlmCallRecord): number {
    const { usage, model } = call.result;
    const priced = [model, call.requestedModel].find(
      (m): m is string => !!m && isPriced(m),
    );
    if (priced) return costMicros(priced, usage);
    this.logger.warn(
      `no price for model "${model ?? call.requestedModel}" (callId ${call.callId}); cost recorded as 0`,
    );
    return 0;
  }

  private giveUp(
    call: LlmCallRecord,
    tokens: number,
    cost: number,
    error: unknown,
  ) {
    this.failures.add(1, { purpose: call.purpose });
    // No content, no user text: only what re-creates the record.
    this.logger.error(
      `llm call record lost: ${JSON.stringify({
        callId: call.callId,
        subjectId: call.subjectId,
        billableTokens: tokens,
        costMicros: cost,
        reason: error instanceof Error ? error.message : String(error),
      })}`,
    );
  }
}
