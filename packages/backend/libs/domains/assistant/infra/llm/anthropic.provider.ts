import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import {
  LlmAbortedError,
  LlmProvider,
  LlmStreamOptions,
  LlmTurnRequest,
  LlmTurnResult,
  LlmUnavailableError,
} from './llm-provider';

/** Refusal fallbacks (server routes by refusal category) + explicit thinking-binding behaviour. */
const BETAS: Anthropic.Beta.AnthropicBeta[] = [
  'server-side-fallback-2026-07-01',
  'thinking-binding-controls-2026-08-01',
];
const REQUEST_TIMEOUT_MS = 120_000;

/** Haiku 4.5 predates adaptive thinking, effort and server-side fallbacks. */
const isLegacyModel = (model: string) => model.startsWith('claude-haiku-4-5');

/**
 * Anthropic Messages API adapter (SD-42).
 *  - streaming for every user-facing turn (no HTTP timeout on long answers),
 *  - adaptive thinking; effort is the cost/quality lever (set per request),
 *  - prompt caching: a breakpoint on the frozen system prompt (covers the
 *    tool definitions rendered before it) + top-level automatic caching that
 *    moves with the growing conversation,
 *  - `fallbacks: "default"`: a classifier refusal is re-run server-side on
 *    the model the API picks for that category, inside the same call,
 *  - `prefix_mismatch_behavior: "drop_block"`: the history is append-only, so
 *    a mismatch means a bug; degrade (drop stale thinking) instead of 400ing
 *    the user, and count it (input_transformations) so it shows on dashboards,
 *  - SDK retries (429/5xx/529, backoff + jitter) then LlmUnavailableError so
 *    the caller can switch to the fallback model before the first token.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly logger = new Logger(AnthropicLlmProvider.name);
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      maxRetries: 2,
      timeout: REQUEST_TIMEOUT_MS,
    });
  }

  async streamTurn(
    request: LlmTurnRequest,
    { signal, onText }: LlmStreamOptions,
  ): Promise<LlmTurnResult> {
    try {
      const stream = this.client.beta.messages.stream(this.params(request), {
        signal,
      });
      stream.on('text', (delta) => onText(delta));
      return this.result(await stream.finalMessage());
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async complete(
    request: LlmTurnRequest,
    signal?: AbortSignal,
  ): Promise<LlmTurnResult> {
    try {
      return this.result(
        await this.client.beta.messages.create(this.params(request), {
          signal,
        }),
      );
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async countTokens(
    request: Omit<LlmTurnRequest, 'maxTokens' | 'effort'>,
  ): Promise<number> {
    const counted = await this.client.beta.messages.countTokens({
      model: request.model,
      system: request.system,
      tools: request.tools as Anthropic.Beta.MessageCountTokensParams['tools'],
      messages: request.messages,
    });
    return counted.input_tokens;
  }

  private params(
    request: LlmTurnRequest,
  ): Anthropic.Beta.MessageCreateParamsNonStreaming {
    const legacy = isLegacyModel(request.model);
    return {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      tools: request.tools,
      messages: request.messages,
      cache_control: { type: 'ephemeral' },
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

  private result(message: Anthropic.Beta.BetaMessage): LlmTurnResult {
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
  private mapError(error: unknown): unknown {
    if (error instanceof Anthropic.APIUserAbortError)
      return new LlmAbortedError();
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = Number(error.headers?.get('retry-after'));
      return new LlmUnavailableError(
        'provider rate limited',
        Number.isFinite(retryAfter) ? retryAfter * 1000 : null,
      );
    }
    if (error instanceof Anthropic.InternalServerError)
      return new LlmUnavailableError(`provider error ${error.status}`, null);
    if (error instanceof Anthropic.APIConnectionError)
      return new LlmUnavailableError('provider unreachable', null);
    return error;
  }
}
