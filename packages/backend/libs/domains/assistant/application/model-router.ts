import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CircuitBreaker, CircuitOpenError } from '@app/common/resilience';
import {
  estimateTokens,
  LLM_PROVIDER,
  LlmAbortedError,
  LlmRejectedError,
  LlmUnavailableError,
  type LlmProvider,
  type LlmRequest,
  type LlmResult,
} from '@app/infrastructure/llm';
import {
  ADMISSION_STORE,
  type AdmissionStore,
} from '../domain/assistant-ports';
import {
  assistantBreakerState,
  assistantFallbacks,
  assistantProviderErrors,
} from './assistant-metrics';
import {
  MeteringService,
  ZERO_USAGE,
  type MeteredCall,
  type MeteredTurn,
} from './metering.service';

/** Every candidate model is cooling down or has an open breaker (nothing was attempted). */
export class AllModelsBlockedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('all models blocked');
    this.name = 'AllModelsBlockedError';
  }
}

export interface RouterCall {
  turn: MeteredTurn;
  request: Omit<LlmRequest, 'model' | 'endUserHash'>;
  /** Cancel, detach, turn deadline, shutdown: aborts the provider call. */
  signal: AbortSignal;
  onText(delta: string): void;
  /** Allocates the next call number of the turn (the callId suffix). */
  nextCall(): number;
  /** Registers the metering of one attempt so the turn can wait for it before its terminal event. */
  track(pending: Promise<unknown>): void;
}

const BREAKER_STATES = ['closed', 'open', 'half_open'] as const;
const DEFAULT_COOLDOWN_MS = 5_000;

/** Opaque per-user value for the provider's abuse tracking; the user id itself is never sent. */
export const endUserHash = (userId: string) =>
  createHash('sha256').update(`assistant:${userId}`).digest('hex').slice(0, 32);

/**
 * Chooses the model for one call and keeps working when the main one struggles (S46 FR-028..FR-031): a breaker per model
 * (5 consecutive transient failures, 30 s, one probe), the provider's `Retry-After` as a fleet-wide cooldown, one
 * fallback attempt and only before the first token, first-token and whole-call deadlines. Non-transient errors are
 * neither retried nor fallen back. Every attempt is recorded and charged (failed ones with zero usage).
 */
@Injectable()
export class ModelRouter {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(ADMISSION_STORE) private readonly admission: AdmissionStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
    private readonly metering: MeteringService,
  ) {}

  private candidates(): string[] {
    const primary = this.config.get('assistant_model');
    const fallback = this.config.get('assistant_fallback_model');
    return primary === fallback ? [primary] : [primary, fallback];
  }

  private breaker(model: string): CircuitBreaker {
    let breaker = this.breakers.get(model);
    if (!breaker) {
      breaker = new CircuitBreaker({
        name: `assistant:${model}`,
        clock: this.clock,
        windowMs: 60_000,
        minimumCalls: 5,
        failureRateThreshold: 1,
        openDurationMs: 30_000,
        halfOpenCalls: 1,
        consecutiveFailures: 5,
        // A user abort, a refusal and a non-transient answer are not provider failures.
        isFailure: (error) => error instanceof LlmUnavailableError,
      });
      this.breakers.set(model, breaker);
      this.publishState(model, breaker);
    }
    return breaker;
  }

  private publishState(model: string, breaker: CircuitBreaker) {
    const current = breaker.state().toLowerCase();
    for (const state of BREAKER_STATES)
      assistantBreakerState.set(state === current ? 1 : 0, { model, state });
  }

  /** Forgets breaker state (specs, and a deploy that changes the model ids). */
  resetBreakers(): void {
    this.breakers.clear();
  }

  /** Milliseconds until the model may be called: its cooldown or its open breaker, whichever lasts longer. */
  private async blockedMs(model: string): Promise<number> {
    const cooldown = await this.admission.cooldownRemainingMs(model);
    return Math.max(cooldown, this.breaker(model).openRemainingMs());
  }

  /** Retry-after of the earliest model to free up when every candidate is blocked; null when one can be tried. */
  async allBlockedFor(): Promise<number | null> {
    const waits = await Promise.all(
      this.candidates().map((m) => this.blockedMs(m)),
    );
    return waits.every((w) => w > 0) ? Math.min(...waits) : null;
  }

  async stream(call: RouterCall): Promise<LlmResult> {
    const models = this.candidates();
    const state = { streamed: false };
    let attempted = 0;
    let lastError: unknown;
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      if ((await this.blockedMs(model)) > 0) continue;
      attempted++;
      try {
        return await this.attempt(model, models[0], call, state);
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          attempted--;
          continue;
        }
        lastError = error;
        const more = i < models.length - 1;
        if (error instanceof LlmUnavailableError && !state.streamed && more) {
          assistantFallbacks.add(1);
          continue;
        }
        throw error;
      }
    }
    if (lastError) throw lastError;
    const waits = await Promise.all(models.map((m) => this.blockedMs(m)));
    throw new AllModelsBlockedError(
      Math.min(...waits.filter((w) => w > 0), DEFAULT_COOLDOWN_MS),
    );
  }

  private async attempt(
    model: string,
    requestedModel: string,
    call: RouterCall,
    state: { streamed: boolean },
  ): Promise<LlmResult> {
    const n = call.nextCall();
    const started = Date.now();
    let ttftMs: number | null = null;
    let emittedChars = 0;
    let deadline: 'first_token' | 'call' | null = null;
    const controller = new AbortController();
    const onTurnAbort = () => controller.abort();
    if (call.signal.aborted) controller.abort();
    else call.signal.addEventListener('abort', onTurnAbort, { once: true });
    const firstTokenTimer = setTimeout(() => {
      deadline = 'first_token';
      controller.abort();
    }, this.config.get('assistant_first_token_timeout_ms'));
    const callTimer = setTimeout(() => {
      deadline = 'call';
      controller.abort();
    }, this.config.get('assistant_call_timeout_ms'));

    const estimatedInput = estimateTokens(
      JSON.stringify([
        call.request.system,
        call.request.tools,
        call.request.messages,
      ]).length,
    );
    const estimatedUsage = () => ({
      ...ZERO_USAGE,
      inputTokens: estimatedInput,
      outputTokens: estimateTokens(emittedChars),
    });
    const record = (
      partial: Pick<
        MeteredCall,
        'outcome' | 'usage' | 'stopReason' | 'usageEstimated'
      > &
        Partial<MeteredCall>,
    ) =>
      call.track(
        this.metering.recordCall(call.turn, {
          n,
          purpose: 'chat',
          requestedModel,
          model,
          ttftMs,
          durationMs: Date.now() - started,
          ...partial,
        }),
      );

    const breaker = this.breaker(model);
    try {
      const { value: result } = await breaker.execute(async () => {
        try {
          return await this.llm.streamTurn(
            {
              ...call.request,
              model,
              endUserHash: endUserHash(call.turn.userId),
            },
            {
              signal: controller.signal,
              onText: (delta) => {
                if (ttftMs === null) {
                  ttftMs = Date.now() - started;
                  clearTimeout(firstTokenTimer);
                }
                state.streamed = true;
                emittedChars += delta.length;
                call.onText(delta);
              },
            },
          );
        } catch (error) {
          // Our own deadline fired (not the turn's abort): a timed-out call is a transient provider failure.
          if (
            error instanceof LlmAbortedError &&
            !call.signal.aborted &&
            deadline
          ) {
            assistantProviderErrors.add(1, { kind: 'timeout' });
            throw new LlmUnavailableError(
              `${deadline} deadline exceeded`,
              null,
            );
          }
          throw error;
        }
      });
      record({
        outcome: result.stopReason === 'refusal' ? 'refused' : 'completed',
        model: result.model,
        usage: result.usage,
        stopReason: result.stopReason,
        content: result.content,
        usageEstimated: false,
      });
      return result;
    } catch (error) {
      if (error instanceof CircuitOpenError) throw error;
      if (error instanceof LlmAbortedError) {
        // A disconnect or stop must not be a free read: charge an estimate of what was used.
        record({
          outcome: 'aborted',
          usage: estimatedUsage(),
          stopReason: null,
          usageEstimated: true,
        });
      } else {
        if (error instanceof LlmUnavailableError) {
          assistantProviderErrors.add(1, { kind: 'unavailable' });
          if (error.rateLimited)
            await this.admission
              .setCooldown(model, error.retryAfterMs ?? DEFAULT_COOLDOWN_MS)
              .catch(() => undefined);
        } else if (error instanceof LlmRejectedError) {
          assistantProviderErrors.add(1, { kind: 'rejected' });
        }
        record({
          outcome: 'failed',
          usage: emittedChars > 0 ? estimatedUsage() : ZERO_USAGE,
          stopReason: null,
          usageEstimated: emittedChars > 0,
        });
      }
      throw error;
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(callTimer);
      call.signal.removeEventListener('abort', onTurnAbort);
      this.publishState(model, breaker);
    }
  }
}
