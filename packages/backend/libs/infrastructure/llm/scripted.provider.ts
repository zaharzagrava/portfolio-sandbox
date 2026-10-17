import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import {
  LlmAbortedError,
  LlmProvider,
  LlmRejectedError,
  LlmRequest,
  LlmResult,
  LlmStreamOptions,
  LlmUnavailableError,
  LlmUsage,
} from './llm-provider';

export interface ScriptedTurn {
  /** Streamed in `chunks` pieces. */
  text?: string;
  chunks?: number;
  toolUses?: { name: string; input: Record<string, unknown> }[];
  stopReason?: Anthropic.Beta.BetaStopReason;
  /** Keep streaming filler until aborted (abort-on-disconnect specs). */
  hang?: boolean;
  /** RAG: indexes of the search_result blocks the text cites (→ search_result_location citations). */
  citations?: number[];
  /** Fail before the first token (fallback-model specs). */
  unavailable?: boolean;
  /** Fail with a non-transient provider answer (400/401). */
  rejected?: boolean;
  /** Fail as a provider 429 before the first token; `null` = no `Retry-After` header. */
  rateLimited?: { retryAfterMs: number | null };
  /** Stream the text, then fail as a transient provider error (no fallback is possible after the first token). */
  failAfterText?: boolean;
  /** A thinking block before the text: it must come back byte for byte in the next request's history. */
  thinking?: string;
  /** Only a call to this model consumes the turn (primary/fallback specs); other calls skip it. */
  model?: string;
  /** Usage reported for the call (defaults: 100 input tokens, one output token per four characters). */
  usage?: Partial<LlmUsage>;
  delayMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new LlmAbortedError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => (clearTimeout(timer), reject(new LlmAbortedError())),
      { once: true },
    );
  });

/**
 * Deterministic provider for e2e specs and keyless local dev: replays queued turns and records every request + abort,
 * so specs assert on what the service SENT (history, tools, model) and that a disconnect really cancelled the call.
 * With an empty queue it echoes, which keeps local dev usable. Refused when `NODE_ENV=production` (AS-74).
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly requests: LlmRequest[] = [];
  aborted = 0;
  private queue: ScriptedTurn[] = [];

  constructor() {
    if (process.env.NODE_ENV === 'production')
      throw new Error(
        'llm_provider: the scripted provider is not allowed in production',
      );
  }

  /** The first queued turn meant for this model (or for any model). */
  private take(model: string): ScriptedTurn | undefined {
    const index = this.queue.findIndex((t) => !t.model || t.model === model);
    return index < 0 ? undefined : this.queue.splice(index, 1)[0];
  }

  script(...turns: ScriptedTurn[]) {
    this.queue.push(...turns);
  }

  reset() {
    this.queue = [];
    this.requests.length = 0;
    this.aborted = 0;
  }

  async streamTurn(
    request: LlmRequest,
    { signal, onText }: LlmStreamOptions,
  ): Promise<LlmResult> {
    this.requests.push(structuredClone(request));
    const turn = this.take(request.model) ?? {
      text: `echo: ${lastUserText(request)}`,
    };
    if (turn.unavailable)
      throw new LlmUnavailableError('scripted overload', null);
    if (turn.rateLimited)
      throw new LlmUnavailableError(
        'scripted rate limit',
        turn.rateLimited.retryAfterMs,
        true,
      );
    if (turn.rejected) throw new LlmRejectedError('scripted rejection', 400);
    try {
      const text = turn.text ?? '';
      const pieces = splitInto(
        text,
        turn.chunks ?? Math.min(5, Math.max(1, text.length)),
      );
      for (const piece of pieces) {
        await sleep(turn.delayMs ?? 5, signal);
        onText(piece);
      }
      if (turn.failAfterText)
        throw new LlmUnavailableError(
          'scripted failure after the first token',
          null,
        );
      while (turn.hang) {
        await sleep(turn.delayMs ?? 50, signal);
        onText('.');
      }
      return this.result(request, turn, text);
    } catch (error) {
      if (error instanceof LlmAbortedError) this.aborted++;
      throw error;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so that a scripted failure is a rejection
  async complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(structuredClone(request));
    const turn = this.take(request.model) ?? {
      text:
        embeddedReply(request) ??
        `summary of ${request.messages.length} messages`,
    };
    if (turn.unavailable)
      throw new LlmUnavailableError('scripted overload', null);
    if (turn.rateLimited)
      throw new LlmUnavailableError(
        'scripted rate limit',
        turn.rateLimited.retryAfterMs,
        true,
      );
    if (turn.rejected) throw new LlmRejectedError('scripted rejection', 400);
    // a scripted delay lets a spec change the world while the call is in flight (S04 AS-33)
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    return this.result(request, turn, turn.text ?? '');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
  async countTokens(
    request: Omit<LlmRequest, 'maxTokens' | 'effort'>,
  ): Promise<number> {
    return Math.ceil(
      JSON.stringify([request.system, request.tools, request.messages]).length /
        4,
    );
  }

  private result(
    request: LlmRequest,
    turn: ScriptedTurn,
    text: string,
  ): LlmResult {
    const content = [
      ...(turn.thinking
        ? [
            {
              type: 'thinking',
              thinking: turn.thinking,
              signature: `sig-${turn.thinking.length}`,
            },
          ]
        : []),
      ...(text
        ? [
            {
              type: 'text',
              text,
              citations: turn.citations
                ? turn.citations.map((i) => searchResultCitation(request, i))
                : null,
            },
          ]
        : []),
      ...(turn.toolUses ?? []).map((t) => ({
        type: 'tool_use',
        id: `toolu_${randomUUID().replace(/-/g, '')}`,
        name: t.name,
        input: t.input,
      })),
    ] as Anthropic.Beta.BetaContentBlock[];
    return {
      content,
      stopReason:
        turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn'),
      refusalCategory: turn.stopReason === 'refusal' ? 'general_harms' : null,
      model: request.model,
      usage: {
        inputTokens: 100,
        outputTokens: Math.max(1, Math.ceil(text.length / 4)),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...turn.usage,
      },
    };
  }
}

/** Mirrors what the API returns for a citation of the i-th search_result block in the last user message. */
const searchResultCitation = (request: LlmRequest, index: number) => {
  const last = request.messages[request.messages.length - 1];
  const blocks = (typeof last.content === 'string' ? [] : last.content).filter(
    (b): b is Anthropic.Beta.BetaSearchResultBlockParam =>
      b.type === 'search_result',
  );
  const cited = blocks[index];
  return {
    type: 'search_result_location',
    search_result_index: index,
    source: cited?.source ?? '',
    title: cited?.title ?? null,
    cited_text: cited?.content.map((c) => c.text).join('') ?? '',
    start_block_index: 0,
    end_block_index: 1,
  };
};

const splitInto = (text: string, n: number): string[] => {
  if (!text) return [];
  const size = Math.ceil(text.length / n);
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );
};

const REPLY_MARKER = 'SCRIPTED-REPLY:';

/**
 * The reply a local document carries for itself: the rest of the line after `SCRIPTED-REPLY:` in a base64 document or
 * text block of the last user message. It lets a black-box journey pass document extraction on a keyless stack, where
 * nothing can queue a turn (J01 G-33). Only reachable through this provider, which is refused in production.
 */
const embeddedReply = (request: LlmRequest): string | undefined => {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  if (!last || typeof last.content === 'string') return undefined;
  for (const block of last.content) {
    const raw =
      block.type === 'document' && block.source.type === 'base64'
        ? Buffer.from(block.source.data, 'base64').toString('latin1')
        : block.type === 'text'
          ? block.text
          : '';
    const at = raw.indexOf(REPLY_MARKER);
    if (at >= 0)
      return raw
        .slice(at + REPLY_MARKER.length)
        .split(/\r?\n/, 1)[0]
        .trim();
  }
  return undefined;
};

const lastUserText = (request: LlmRequest): string => {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  // The turn runner appends a `<context>` block to the user's text; the echo is the user's words only.
  return last.content
    .map((b) =>
      b.type === 'text' && !b.text.startsWith('<context>') ? b.text : '',
    )
    .join('');
};
