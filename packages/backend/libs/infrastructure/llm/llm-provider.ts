import type Anthropic from '@anthropic-ai/sdk';

/** What a caller sends per model call. SDK types end to end - no hand-rolled message shapes. Document/image blocks go in `messages`. */
export interface LlmRequest {
  model: string;
  /** Frozen per conversation: changing it between requests invalidates cache + thinking blocks. */
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
  messages: Anthropic.Beta.BetaMessageParam[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Keep `tools` (it is part of the cached/bound prefix) but forbid calling them: `tool_choice: none`. */
  toolsDisabled?: boolean;
  /** Structured outputs: the reply's text is JSON valid against this schema (constrained decoding). */
  outputSchema?: Record<string, unknown>;
  /** Whole-call budget (one attempt). Default 120 000 ms. */
  timeoutMs?: number;
  /** Deadline for the first streamed token, shared by all attempts of one call. Default 30 000 ms. */
  firstTokenTimeoutMs?: number;
  /** Retries of transient failures before the first token, 0-2 (default 2). 0: exactly one attempt. */
  maxRetries?: number;
  /** Opaque hash of the end user, forwarded to the provider's abuse detection. */
  endUserHash?: string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResult {
  /** Exactly what the model returned - replayed verbatim on the next request (thinking blocks included). */
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: Anthropic.Beta.BetaStopReason | null;
  refusalCategory: string | null;
  /** Model that actually answered (differs from the request on a fallback). */
  model: string;
  usage: LlmUsage;
}

export interface LlmStreamOptions {
  signal: AbortSignal;
  onText(delta: string): void;
}

/**
 * Port in front of the model provider (SD-42). The Anthropic adapter is the production one; the scripted adapter drives
 * e2e specs and keyless local development. Imports no domain code.
 */
export interface LlmProvider {
  readonly name: string;
  streamTurn(
    request: LlmRequest,
    options: LlmStreamOptions,
  ): Promise<LlmResult>;
  /** Non-streamed, short output (summaries, extraction). */
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResult>;
  countTokens(
    request: Omit<LlmRequest, 'maxTokens' | 'effort'>,
  ): Promise<number>;
}

/**
 * Fleet-wide "not before" instant per model, bound by the caller that owns shared state (the assistant binds Redis).
 * The adapter calls `set` on a provider 429; without a binding nothing is shared.
 */
export interface CooldownStore {
  set(model: string, durationMs: number): void | Promise<void>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const LLM_COOLDOWN_STORE = Symbol('LLM_COOLDOWN_STORE');

/** Former names of the request/result types (callers migrate to `LlmRequest` / `LlmResult` with their next edit). */
export type LlmTurnRequest = LlmRequest;
export type LlmTurnResult = LlmResult;

/** Thrown when the caller (disconnect / cancel) aborted the call - not a provider failure. */
export class LlmAbortedError extends Error {
  constructor() {
    super('LLM call aborted');
    this.name = 'LlmAbortedError';
  }
}

/** Transient provider failure (429, 5xx, 529, reset, timeout) after the adapter's own retries. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    /** The provider answered 429 (the caller's model cooldown starts from this). */
    readonly rateLimited = false,
  ) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/** Non-transient provider answer (400/401/403/404/422 and other 4xx): retrying or switching model does not help. */
export class LlmRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'LlmRejectedError';
  }
}

export const textOf = (content: Anthropic.Beta.BetaContentBlock[]) =>
  content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
