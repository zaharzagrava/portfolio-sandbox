import { Inject, Injectable } from '@nestjs/common';
import { PRODUCT_INDEX, type ProductIndexPort } from '../domain/ports';
import {
  CatalogTimeoutError,
  type CatalogTitleSource,
} from '../domain/autocomplete-ports';

/**
 * `CatalogTitleSource` over the in-domain product index port, visible products only (S33 R-1). It replaces the direct use
 * of `ElasticsearchService.suggestTitles`. When S32 exports `ProductTitleSuggester` this adapter wraps it instead; until
 * then the typo method is not available and rejects, which the service reports as `typo_fallback_unavailable`.
 */
@Injectable()
export class CatalogTitleSourceAdapter implements CatalogTitleSource {
  constructor(
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
  ) {}

  async suggestTitles(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    try {
      return await this.index.suggestTitles(prefix, size, signal);
    } catch (error) {
      // the budget fired, or the engine client gave up on its own clock: both are "too slow", not "broken"
      const cause = (error as { cause?: { name?: string } }).cause;
      if (signal?.aborted || cause?.name === 'TimeoutError')
        throw new CatalogTimeoutError();
      throw error;
    }
  }

  suggestTitlesFuzzy(): Promise<string[]> {
    return Promise.reject(
      new Error(
        'typo-tolerant title suggestions are not provided by search yet',
      ),
    );
  }
}
