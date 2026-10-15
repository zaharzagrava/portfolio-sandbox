import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import { sleep as abortableSleep } from '@app/common/core/backoff';
import {
  BackoffOptions,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_RETRY_BACKOFF,
  retryDelayMs,
} from './backoff';
import {
  LlmAbortedError,
  LlmProvider,
  LlmRejectedError,
  LlmRequest,
  LlmResult,
  LlmStreamOptions,
  LlmUnavailableError,
} from './llm-provider';

/** Refusal fallbacks (server routes by refusal category) + explicit thinking-binding behaviour. */
const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  'server-side-fallback-2026-07-01',
  'thinking-binding-controls-2026-08-01',
];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30_000;
/** The adapter never retries more than twice, whatever a caller asks for (AS-50). */
const MAX_RETRIES = 2;

/** Haiku 4.5 predates adaptive thinking, effort and server-side fallbacks. */
const isLegacyModel = (model: string) => model.startsWith('claude-haiku-4-5');

export interface AnthropicProviderOptions {
  /** A local double or a gateway; default the public API. */
  baseURL?: string;
  backoff?: BackoffOptions;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** A provider 429 (fleet-wide model cooldown); `retryAfterMs` is the header or 5 s. */
  onRateLimited?: (model: string, retryAfterMs: number) => void;
}

/** Why one attempt ended without a result. */
class AttemptFailure extends Error {
  constructor(
    readonly mapped: LlmUnavailableError | LlmRejectedError | LlmAbortedError,
    /** A token had arrived: the attempt can no longer be repeated without duplicating output. */
    readonly afterFirstToken: boolean,
  ) {
    super(mapped.message);
  }
}

/**
 * Anthropic Messages API adapter (SD-42).
 *  - streaming for every user-facing turn (no HTTP timeout on long answers),
 *  - adaptive thinking; effort is the cost/quality lever (set per request),
 *  - prompt caching: a breakpoint on the frozen system prompt (covers the tool definitions rendered before it) +
 *    top-level automatic caching that moves with the growing conversation,
 *  - `fallbacks: "default"`: a classifier refusal is re-run server-side on the model the API picks for that category,
 *  - `prefix_mismatch_behavior: "drop_block"`: the history is append-only, so a mismatch means a bug; degrade (drop
 *    stale thinking) instead of 400ing the user, and count it so it shows on dashboards,
 *  - the SDK does not retry: this adapter is the one retry layer (AS-50). Transient failures (429 honouring
 *    Retry-After, 5xx, 529, reset, timeout) are retried at most `maxRetries` (<= 2) times, only before the first token
 *    and never past the first-token deadline; everything else surfaces as a typed error (`LlmUnavailableError`
 *    transient, `LlmRejectedError` not) so the caller can switch to a fallback model or fail.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicLlmProvider.name);
  private readonly client: Anthropic;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    apiKey: string,
    private readonly options: AnthropicProviderOptions = {},
  ) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: DEFAULT_TIMEOUT_MS,
      ...(options.baseURL && { baseURL: options.baseURL }),
    });
    this.backoff = options.backoff ?? DEFAULT_RETRY_BACKOFF;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? abortableSleep;
  }

  streamTurn(
    request: LlmRequest,
    { signal, onText }: LlmStreamOptions,
  ): Promise<LlmResult> {
    const deadlineMs =
      request.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    return this.withRetries(request, signal, deadlineMs, () =>
      this.streamOnce(request, signal, deadlineMs, onText),
    );
  }

  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResult> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return this.withRetries(request, signal, timeoutMs, async () => {
      try {
        return this.result(
          await this.client.beta.messages.create(this.params(request), {
            signal,
            timeout: timeoutMs,
            maxRetries: 0,
          }),
        );
      } catch (error) {
        throw new AttemptFailure(this.mapError(error), false);
      }
    });
  }

  async countTokens(
    request: Omit<LlmRequest, 'maxTokens' | 'effort'>,
  ): Promise<number> {
    try {
      const counted = await this.client.beta.messages.countTokens({
        model: request.model,
        system: request.system,
        tools: request.tools,
        messages: request.messages,
      });
      return counted.input_tokens;
    } catch (error) {
      throw this.mapError(error);
    }
  }

  /**
   * The one retry loop. `deadlineMs` is the first-token deadline of a stream (the call timeout for `complete`): a
   * backoff wait that would reach it is not made, the typed error carries the provider's `retryAfterMs` instead.
   */
  private async withRetries(
    request: LlmRequest,
    signal: AbortSignal | undefined,
    deadlineMs: number,
    attempt: () => Promise<LlmResult>,
  ): Promise<LlmResult> {
    const maxRetries = Math.min(
      MAX_RETRIES,
      Math.max(0, request.maxRetries ?? MAX_RETRIES),
    );
    for (let retry = 0; ; retry++) {
      try {
        return await attempt();
      } catch (error) {
        if (!(error instanceof AttemptFailure)) throw error;
        const failure = error.mapped;
        if (failure instanceof LlmUnavailableError && failure.rateLimited)
          this.options.onRateLimited?.(
            request.model,
            failure.retryAfterMs ?? DEFAULT_COOLDOWN_MS,
          );
        if (
          !(failure instanceof LlmUnavailableError) ||
          error.afterFirstToken ||
          retry >= maxRetries
        )
          throw failure;
        const delay = retryDelayMs(
          retry,
          failure.retryAfterMs,
          this.backoff,
          this.random,
        );
        if (delay >= deadlineMs) throw failure;
        this.logger.warn(
          `provider transient failure (${failure.message}); retry ${retry + 1} in ${delay} ms`,
        );
        try {
          await this.sleep(delay, signal);
        } catch {
          throw new LlmAbortedError();
        }
      }
    }
  }

  private async streamOnce(
    request: LlmRequest,
    signal: AbortSignal | undefined,
    deadlineMs: number,
    onText: (delta: string) => void,
  ): Promise<LlmResult> {
    // One controller for this attempt: the caller's abort, and the first-token deadline.
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    let firstToken = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    try {
      const stream = this.client.beta.messages.stream(this.params(request), {
        signal: controller.signal,
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 0,
      });
      stream.on('streamEvent', (event) => {
        if (firstToken) return;
        if (event.type === 'content_block_delta') {
          firstToken = true;
          clearTimeout(timer);
        }
      });
      stream.on('text', (delta) => onText(delta));
      return this.result(await stream.finalMessage());
    } catch (error) {
      if (timedOut && !firstToken && !signal?.aborted)
        throw new AttemptFailure(
          new LlmUnavailableError('provider first token timeout', null),
          false,
        );
      throw new AttemptFailure(this.mapError(error), firstToken);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private params(
    request: LlmRequest,
  ): Anthropic.Beta.MessageCreateParamsNonStreaming {
    const legacy = isLegacyModel(request.model);
    return {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      tools: request.tools,
      messages: request.messages,
      cache_control: { type: 'ephemeral' },
      ...(request.endUserHash && {
        metadata: { user_id: request.endUserHash },
      }),
      ...(request.toolsDisabled && { tool_choice: { type: 'none' } }),
      output_config: {
        ...(!legacy && { effort: request.effort ?? 'low' }),
        ...(request.outputSchema && {
          format: { type: 'json_schema', schema: request.outputSchema },
        }),
      },
      ...(!legacy && {
        thinking: {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
        fallbacks: 'default',
        betas: BETAS,
      }),
    };
  }

  private result(message: Anthropic.Beta.BetaMessage): LlmResult {
    const dropped = (message.input_transformations ?? []).filter(
      (t) => t.type === 'thinking_dropped',
    );
    if (dropped.length)
      this.logger.warn(`thinking blocks dropped: ${JSON.stringify(dropped)}`);
    return {
      content: message.content,
      stopReason: message.stop_reason,
      refusalCategory:
        message.stop_reason === 'refusal'
          ? (message.stop_details?.category ?? null)
          : null,
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  /** Typed SDK errors, most specific first - never string matching. */
  private mapError(
    error: unknown,
  ): LlmUnavailableError | LlmRejectedError | LlmAbortedError {
    if (error instanceof Anthropic.APIUserAbortError)
      return new LlmAbortedError();
    if (error instanceof Anthropic.APIConnectionTimeoutError)
      return new LlmUnavailableError('provider timeout', null);
    if (error instanceof Anthropic.APIConnectionError)
      return new LlmUnavailableError('provider unreachable', null);
    if (error instanceof Anthropic.APIError) {
      const status = error.status;
      if (status === 429)
        return new LlmUnavailableError(
          'provider rate limited',
          retryAfterMs(error.headers),
          true,
        );
      if (status !== undefined && status >= 500)
        return new LlmUnavailableError(
          `provider error ${status}`,
          retryAfterMs(error.headers),
        );
      return new LlmRejectedError(
        `provider rejected the request (${status ?? 'no status'})`,
        status ?? null,
      );
    }
    // A mid-stream parse failure or socket error that the SDK did not wrap is a broken connection.
    return new LlmUnavailableError('provider stream failed', null);
  }
}

/** `Retry-After` is seconds or an HTTP date; `retry-after-ms` is the provider's finer variant. */
function retryAfterMs(
  headers: Headers | Record<string, string | null | undefined> | undefined,
): number | null {
  const get = (name: string): string | null | undefined =>
    headers instanceof Headers ? headers.get(name) : headers?.[name];
  const ms = Number(get('retry-after-ms'));
  if (get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
