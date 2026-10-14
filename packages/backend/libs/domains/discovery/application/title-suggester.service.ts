import { Inject, Injectable } from '@nestjs/common';
import { EngineUnavailableError } from '@app/infrastructure/elasticsearch/search-engine.errors';
import { normaliseQuery } from '../domain/query-text';
import { PRODUCT_INDEX, type ProductIndexPort } from '../domain/ports';
import {
  SearchValidationError,
  SuggestionTimeoutError,
} from '../domain/search-errors';
import { SearchSettings } from '../infra/search-settings';

/** Titles are for typing aids: never more than this many at a time (S32 FR-057). */
export const MAX_SUGGESTION_SIZE = 10;

/**
 * Visible product titles for autocomplete (S33 R1). The visibility filter is the search's, so an archived, sandbox,
 * deleted or suspended-shop product is never suggested. A call that outlives its signal or the engine budget fails with
 * the typed `SuggestionTimeoutError` instead of hanging.
 */
@Injectable()
export class ProductTitleSuggester {
  constructor(
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    private readonly settings: SearchSettings,
  ) {}

  suggestTitles(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.run(
      (text) => this.index.suggestTitles(text, size, signal),
      prefix,
      size,
      signal,
    );
  }

  suggestTitlesFuzzy(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.run(
      (text) => this.index.suggestTitlesFuzzy(text, size, signal),
      prefix,
      size,
      signal,
    );
  }

  private async run(
    call: (normalised: string) => Promise<string[]>,
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (!Number.isInteger(size) || size < 1 || size > MAX_SUGGESTION_SIZE)
      throw new SearchValidationError(['size']);
    const text = normaliseQuery(prefix);
    if (text === '') return [];
    if (signal?.aborted)
      throw new SuggestionTimeoutError(this.settings.searchBudgetMs);
    try {
      return await call(text);
    } catch (error) {
      if (signal?.aborted || isTimeout(error))
        throw new SuggestionTimeoutError(this.settings.searchBudgetMs);
      throw error;
    }
  }
}

/** The client gave up on its own clock: "too slow", not "broken". */
const isTimeout = (error: unknown): boolean => {
  if (!(error instanceof EngineUnavailableError)) return false;
  const name = (error.cause as { name?: string } | undefined)?.name;
  return name === 'TimeoutError' || name === 'RequestAbortedError';
};
