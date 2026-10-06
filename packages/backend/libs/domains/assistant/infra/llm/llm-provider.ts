import type Anthropic from '@anthropic-ai/sdk';



/** What the assistant sends per model call. SDK types end to end - no hand-rolled message shapes. */
export interface LlmTurnRequest {
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
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmTurnResult {
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
 * Port in front of the model provider (SD-42). The Anthropic adapter is the
 * production one; the scripted adapter drives e2e specs and local dev
 * without an API key.
 */
export interface LlmProvider {
  readonly name: string;
  streamTurn(request: LlmTurnRequest, options: LlmStreamOptions): Promise<LlmTurnResult>;
  /** Non-streamed, short output (summaries). */
  complete(request: LlmTurnRequest, signal?: AbortSignal): Promise<LlmTurnResult>;
  countTokens(request: Omit<LlmTurnRequest, 'maxTokens' | 'effort'>): Promise<number>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/** Thrown when the user (disconnect / cancel) aborted the call - not a provider failure. */
export class LlmAbortedError extends Error {
  constructor() {
    super('LLM call aborted');
  }
}

/** Provider overloaded / rate limited after the SDK's own retries. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

export const textOf = (content: Anthropic.Beta.BetaContentBlock[]) =>
  content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
