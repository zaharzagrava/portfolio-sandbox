import type Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { LlmAbortedError, LlmProvider, LlmStreamOptions, LlmTurnRequest, LlmTurnResult, LlmUnavailableError } from './llm-provider';

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
  delayMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new LlmAbortedError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(new LlmAbortedError())), { once: true });
  });

/**
 * Deterministic provider for e2e specs and keyless local dev: replays queued
 * turns and records every request + abort, so specs assert on what the
 * service SENT (history, tools, model) and that a disconnect really cancelled
 * the call. With an empty queue it echoes, which keeps local dev usable.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly requests: LlmTurnRequest[] = [];
  aborted = 0;
  private queue: ScriptedTurn[] = [];

  script(...turns: ScriptedTurn[]) {
    this.queue.push(...turns);
  }

  reset() {
    this.queue = [];
    this.requests.length = 0;
    this.aborted = 0;
  }

  async streamTurn(request: LlmTurnRequest, { signal, onText }: LlmStreamOptions): Promise<LlmTurnResult> {
    this.requests.push(structuredClone(request));
    const turn = this.queue.shift() ?? { text: `echo: ${lastUserText(request)}` };
    if (turn.unavailable) throw new LlmUnavailableError('scripted overload', null);
    try {
      const text = turn.text ?? '';
      const pieces = splitInto(text, turn.chunks ?? Math.min(5, Math.max(1, text.length)));
      for (const piece of pieces) {
        await sleep(turn.delayMs ?? 5, signal);
        onText(piece);
      }
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

  async complete(request: LlmTurnRequest): Promise<LlmTurnResult> {
    this.requests.push(structuredClone(request));
    const turn = this.queue.shift() ?? { text: `summary of ${request.messages.length} messages` };
    return this.result(request, turn, turn.text ?? '');
  }

  async countTokens(request: Omit<LlmTurnRequest, 'maxTokens' | 'effort'>): Promise<number> {
    return Math.ceil(JSON.stringify([request.system, request.tools, request.messages]).length / 4);
  }

  private result(request: LlmTurnRequest, turn: ScriptedTurn, text: string): LlmTurnResult {
    const content = [
      ...(text ? [{ type: 'text', text, citations: turn.citations ? turn.citations.map((i) => searchResultCitation(request, i)) : null }] : []),
      ...(turn.toolUses ?? []).map((t) => ({ type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '')}`, name: t.name, input: t.input })),
    ] as Anthropic.Beta.BetaContentBlock[];
    return {
      content,
      stopReason: turn.stopReason ?? (turn.toolUses?.length ? 'tool_use' : 'end_turn'),
      refusalCategory: turn.stopReason === 'refusal' ? 'general_harms' : null,
      model: request.model,
      usage: { inputTokens: 100, outputTokens: Math.max(1, Math.ceil(text.length / 4)), cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }
}

/** Mirrors what the API returns for a citation of the i-th search_result block in the last user message. */
const searchResultCitation = (request: LlmTurnRequest, index: number) => {
  const last = request.messages[request.messages.length - 1];
  const blocks = (typeof last.content === 'string' ? [] : last.content).filter((b): b is Anthropic.Beta.BetaSearchResultBlockParam => b.type === 'search_result');
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
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
};

const lastUserText = (request: LlmTurnRequest): string => {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
};
