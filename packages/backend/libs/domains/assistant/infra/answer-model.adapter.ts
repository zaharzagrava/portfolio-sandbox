import { Inject, Injectable } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import {
  AnswerAbortedError,
  AnswerBlock,
  AnswerModel,
  AnswerPassage,
  AnswerRequest,
  AnswerResult,
  AnswerUnavailableError,
} from '../domain/ports';
import {
  LLM_PROVIDER,
  LlmAbortedError,
  LlmUnavailableError,
} from './llm/llm-provider';
import type { LlmProvider } from './llm/llm-provider';

/**
 * INTERIM adapter (S47 R-2): binds the `AnswerModel` port to the existing `LLM_PROVIDER`. S46's
 * `@app/infrastructure/llm` replaces this one file; nothing else in the knowledge half imports `./llm/*`.
 */
@Injectable()
export class AnswerModelAdapter implements AnswerModel {
  constructor(@Inject(LLM_PROVIDER) private readonly llm: LlmProvider) {}

  get scripted(): boolean {
    return this.llm.name === 'scripted';
  }

  async stream(
    request: AnswerRequest,
    options: { signal: AbortSignal; onText: (delta: string) => void },
  ): Promise<AnswerResult> {
    try {
      const result = await this.llm.streamTurn(
        {
          model: request.model,
          system: [
            {
              type: 'text',
              text: request.instructions,
              cache_control: { type: 'ephemeral' },
            },
          ],
          tools: [],
          messages: [
            {
              role: 'user',
              content: [
                ...request.passages.map(toSearchResult),
                { type: 'text', text: request.question },
              ],
            },
          ],
          maxTokens: request.maxTokens,
          effort: 'low',
        },
        options,
      );
      const blocks: AnswerBlock[] = result.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => ({
          text: b.text,
          citations: (b.citations ?? []).map((c) =>
            c.type === 'search_result_location'
              ? { kind: 'result' as const, index: c.search_result_index }
              : { kind: 'other' as const, index: 0 },
          ),
        }));
      return {
        blocks,
        refused: result.stopReason === 'refusal',
        refusalCategory: result.refusalCategory,
        model: result.model,
        usage: result.usage,
        stopReason: result.stopReason ?? 'unknown',
      };
    } catch (error) {
      if (error instanceof LlmAbortedError) throw new AnswerAbortedError();
      if (error instanceof LlmUnavailableError)
        throw new AnswerUnavailableError();
      throw error;
    }
  }
}

const toSearchResult = (
  p: AnswerPassage,
): Anthropic.Beta.BetaSearchResultBlockParam => ({
  type: 'search_result',
  source: p.source,
  title: p.title,
  content: [{ type: 'text', text: p.text }],
  citations: { enabled: true },
});
