import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  productSearchQuerySchema,
  type ProductSearchQuery,
  type ProductSearchResponse,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  EngineRejectedError,
  EngineUnavailableError,
} from '@app/infrastructure/elasticsearch/search-engine.errors';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchFingerprint,
} from '../domain/search-cursor';
import {
  InvalidPriceRangeError,
  SearchUnavailableError,
  SearchValidationError,
  UnsupportedCombinationError,
} from '../domain/search-errors';
import { signSearchId } from '../domain/search-id';
import { exceedsQueryLimit, logForm, normaliseQuery } from '../domain/query-text';
import {
  PRODUCT_INDEX,
  SEARCH_EVENT_PUBLISHER,
  type EngineSearchRequest,
  type ProductIndexPort,
  type SearchEventPublisher,
} from '../domain/ports';
import {
  searchDuration,
  searchRequestsCounter,
  searchUnavailableCounter,
} from '../infra/search-metrics';
import { SearchSettings } from '../infra/search-settings';

export interface SearchCall {
  /** The query-string parameters exactly as received (strings), or an already typed request from another domain. */
  query: Record<string, unknown>;
  surface: 'http' | 'internal';
  /** The user id, or the client address for an anonymous caller. */
  subject: string;
}

const FILTER_NAMES = [
  'category',
  'brand',
  'minPriceMinor',
  'maxPriceMinor',
  'minRating',
  'inStock',
] as const;

const INTERNAL_MAX_LIMIT = 20;

/**
 * The public product search (S32 US1) and the exported in-process service other domains call (R1). One engine query
 * per search; invalid input never reaches the engine; the answer is an explicit DTO (no index field leaks); the event
 * stream hears about it without ever slowing or failing the search.
 */
@Injectable()
export class ProductSearchService {
  private readonly logger = new Logger(ProductSearchService.name);

  constructor(
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    @Inject(SEARCH_EVENT_PUBLISHER)
    private readonly events: SearchEventPublisher,
    private readonly settings: SearchSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async search(call: SearchCall): Promise<ProductSearchResponse> {
    const started = process.hrtime.bigint();
    const request = this.validate(call);
    let mode: ProductSearchResponse['mode'] = 'browse';
    try {
      const { query, q, fingerprint, after } = request;
      mode = q === null ? 'browse' : 'lexical';
      const engine: EngineSearchRequest = {
        q,
        filters: {
          ...(query.category !== undefined && { category: query.category }),
          ...(query.brand !== undefined && { brand: query.brand }),
          ...(query.minPriceMinor !== undefined && {
            minPriceMinor: query.minPriceMinor,
          }),
          ...(query.maxPriceMinor !== undefined && {
            maxPriceMinor: query.maxPriceMinor,
          }),
          ...(query.minRating !== undefined && { minRating: query.minRating }),
          ...(query.inStock !== undefined && { inStock: query.inStock }),
        },
        sort: query.sort ?? 'relevance',
        limit: query.limit,
        after,
      };
      const result = await this.index.search(engine);
      const page = result.hits.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        result.hits.length > query.limit && last
          ? encodeSearchCursor({ sv: last.sort, id: last.id }, fingerprint)
          : null;

      const logged = q === null ? null : logForm(q);
      const searchId = signSearchId(
        this.settings.signingKey,
        { sid: randomUUID(), q: logged ?? '' },
        this.clock.now().getTime(),
      );
      const response: ProductSearchResponse = {
        searchId,
        mode,
        items: page.map((hit, position) => {
          const s = hit.source;
          return {
            id: hit.id,
            shopId: s.shopId ?? '',
            title: s.title ?? '',
            brand: s.brand ?? null,
            category: s.category ?? '',
            priceMinor: s.priceMinor ?? 0,
            currency: s.currency ?? 'USD',
            rating: s.rating ?? 0,
            inStock: s.inStock ?? false,
            imageUrl: s.imageUrl ?? null,
            sponsored: s.sponsored ?? false,
            position,
          };
        }),
        total: result.total,
        nextCursor,
        degraded: [],
      };
      searchRequestsCounter.add(1, { mode, status: 'ok' });
      if (logged !== null)
        this.events.performed({
          searchId,
          rawQuery: q ?? '',
          results: result.total.value,
          mode,
          filters: FILTER_NAMES.filter((n) => query[n] !== undefined),
          degraded: [],
          surface: call.surface,
          subject: call.subject,
        });
      return response;
    } catch (error) {
      if (error instanceof EngineUnavailableError) {
        searchUnavailableCounter.add(1);
        searchRequestsCounter.add(1, { mode, status: 'unavailable' });
        throw new SearchUnavailableError(error);
      }
      if (error instanceof EngineRejectedError) {
        this.logger.error(`search engine rejected a query: ${error.message}`);
        searchRequestsCounter.add(1, { mode, status: 'unavailable' });
        throw new SearchUnavailableError(error);
      }
      throw error;
    } finally {
      searchDuration.record(Number(process.hrtime.bigint() - started) / 1e9);
    }
  }

  /** Everything that can be refused without asking the engine (FR-001, FR-007 to FR-009, AS-10). */
  private validate(call: SearchCall): {
    query: ProductSearchQuery;
    q: string | null;
    fingerprint: string;
    after: (string | number)[] | null;
  } {
    const parsed = productSearchQuerySchema.safeParse(call.query);
    if (!parsed.success) {
      const fields = new Set<string>();
      for (const issue of parsed.error.issues) {
        if (issue.code === 'unrecognized_keys')
          for (const key of issue.keys) fields.add(key);
        else fields.add(issue.path.length > 0 ? String(issue.path[0]) : 'query');
      }
      searchRequestsCounter.add(1, { mode: 'browse', status: 'invalid' });
      throw new SearchValidationError([...fields]);
    }
    const query = parsed.data;
    const text = query.q === undefined ? '' : normaliseQuery(query.q);
    if (query.q !== undefined && exceedsQueryLimit(query.q))
      throw new SearchValidationError(['q']);
    if (
      query.minPriceMinor !== undefined &&
      query.maxPriceMinor !== undefined &&
      query.minPriceMinor > query.maxPriceMinor
    )
      throw new InvalidPriceRangeError();
    if (call.surface === 'internal') {
      if (query.limit > INTERNAL_MAX_LIMIT)
        throw new SearchValidationError(['limit']);
      if (query.cursor !== undefined) throw new SearchValidationError(['cursor']);
      if (query.facets !== undefined) throw new SearchValidationError(['facets']);
    }
    // Facets (US2) and semantic mode (US3) are not served yet: refuse rather than silently answer without them.
    if (query.facets === true) throw new UnsupportedCombinationError(['facets']);
    if (query.semantic === true)
      throw new UnsupportedCombinationError(['semantic']);

    const q = text === '' ? null : text;
    const mode = q === null ? 'browse' : 'lexical';
    const sort = query.sort ?? 'relevance';
    const fingerprint = searchFingerprint({
      q,
      filters: Object.fromEntries(
        FILTER_NAMES.filter((n) => query[n] !== undefined).map((n) => [
          n,
          query[n],
        ]),
      ),
      sort,
      mode,
    });
    const after =
      query.cursor === undefined
        ? null
        : decodeSearchCursor(query.cursor, fingerprint).sv;
    return { query, q, fingerprint, after };
  }
}
