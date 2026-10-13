import { Injectable } from '@nestjs/common';
import { ProductTitleSuggester } from '../application/title-suggester.service';
import { SuggestionTimeoutError } from '../domain/search-errors';
import {
  CatalogTimeoutError,
  type CatalogTitleSource,
} from '../domain/autocomplete-ports';

/**
 * `CatalogTitleSource` (S33's port) over search's `ProductTitleSuggester`: visible products only. A suggestion that
 * ran out of budget is reported the way autocomplete expects it (`CatalogTimeoutError`).
 */
@Injectable()
export class CatalogTitleSourceAdapter implements CatalogTitleSource {
  constructor(private readonly suggester: ProductTitleSuggester) {}

  suggestTitles(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.timed(this.suggester.suggestTitles(prefix, size, signal));
  }

  suggestTitlesFuzzy(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.timed(this.suggester.suggestTitlesFuzzy(prefix, size, signal));
  }

  private async timed(call: Promise<string[]>): Promise<string[]> {
    try {
      return await call;
    } catch (error) {
      if (error instanceof SuggestionTimeoutError)
        throw new CatalogTimeoutError();
      throw error;
    }
  }
}
