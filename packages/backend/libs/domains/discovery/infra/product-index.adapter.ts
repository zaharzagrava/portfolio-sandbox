import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import { assertNever } from '@app/common/core/assert-never';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import {
  EngineRejectedError,
  EngineUnavailableError,
} from '@app/infrastructure/elasticsearch/search-engine.errors';
import {
  MAX_BOOST_MULTIPLIER,
  tierFactor as tierFactorOf,
} from '../domain/boost';
import { visibilityFilter } from '../domain/visibility-filter';
import {
  emptyDocument,
  type IndexedDocument,
  type Mutation,
} from '../domain/index-document';
import type { GuardOutcome } from '../domain/projection-guard';
import type {
  EngineSearchRequest,
  EngineSearchResult,
  FacetCounts,
  ProductIndexPort,
  ShopStampWrite,
} from '../domain/ports';
import { PRODUCTS_ALIAS } from './search-index-names';
import { SearchIndexRegistry } from './search-index-registry';
import { SearchSettings } from './search-settings';

const MAX_ATTEMPTS = 6;
/** Totals above this are reported as a lower bound (`exact: false`). */
const TOTAL_HITS_CAP = 10_000;
const LIST_FIELDS = [
  'productId',
  'shopId',
  'title',
  'brand',
  'category',
  'priceMinor',
  'currency',
  'rating',
  'inStock',
  'imageUrl',
  'sponsored',
];
const CONFLICT = 'version_conflict_engine_exception';
const FACET_SIZE = 20;
type Selection = 'category' | 'brand' | 'price';
const PRICE_RANGE_KEYS = ['under_25', '25_to_50', '50_to_100', 'over_100'];

interface FacetAggregations {
  categories?: { top?: { buckets: { key: string; doc_count: number }[] } };
  brands?: { top?: { buckets: { key: string; doc_count: number }[] } };
  priceRanges?: {
    top?: { buckets: Record<string, { doc_count: number } | undefined> };
  };
  rating?: { avg?: { value: number | null } };
}

interface MgetDoc {
  _id: string;
  found: boolean;
  _seq_no?: number;
  _primary_term?: number;
  _source?: Partial<IndexedDocument>;
}

interface BulkResultItem {
  status?: number;
  error?: { type?: string; reason?: string };
}

export const toStored = (
  id: string,
  source: Partial<IndexedDocument> | undefined,
): IndexedDocument => ({ ...emptyDocument(id), ...(source ?? {}) });

/**
 * `ProductIndexPort` over the generic engine client. Every source writes through `mutate`: read the stored document
 * with its sequence number, compute the next document with a pure function (the version guards and score live in the
 * domain), write it with `if_seq_no` / `if_primary_term`, and retry on a conflict. That makes five independent
 * writers (product, shop state, image, sponsorship, popularity) safe on one document without scripts.
 */
@Injectable()
export class ProductIndexAdapter implements ProductIndexPort {
  constructor(
    private readonly engine: SearchEngineClient,
    private readonly registry: SearchIndexRegistry,
    private readonly settings: SearchSettings,
  ) {}

  async read(ids: string[]): Promise<Map<string, IndexedDocument>> {
    const out = new Map<string, IndexedDocument>();
    if (ids.length === 0) return out;
    const res = await this.engine.mget(PRODUCTS_ALIAS, ids);
    for (const d of res.docs as MgetDoc[])
      if (d.found) out.set(d._id, toStored(d._id, d._source));
    return out;
  }

  async readFrom(
    index: string,
    ids: string[],
  ): Promise<Map<string, IndexedDocument>> {
    const out = new Map<string, IndexedDocument>();
    if (ids.length === 0) return out;
    const res = await this.engine.mget(index, ids);
    for (const d of res.docs as MgetDoc[])
      if (d.found) out.set(d._id, toStored(d._id, d._source));
    return out;
  }

  async mutate(
    items: { id: string; mutation: Mutation }[],
  ): Promise<Map<string, GuardOutcome>> {
    const targets = await this.registry.writeSet();
    if (targets.length === 0)
      throw new EngineUnavailableError('no index behind the products alias');
    const unique = [...new Map(items.map((i) => [i.id, i])).values()];
    let live: Map<string, GuardOutcome> = new Map();
    for (let t = 0; t < targets.length; t++) {
      const outcomes = await this.mutateOn(targets[t], unique);
      if (t === 0) live = outcomes;
    }
    return live;
  }

  async mutateOn(
    index: string,
    items: { id: string; mutation: Mutation }[],
  ): Promise<Map<string, GuardOutcome>> {
    const outcomes = new Map<string, GuardOutcome>();
    let pending = items;
    for (let attempt = 1; pending.length > 0; attempt++) {
      if (attempt > MAX_ATTEMPTS)
        throw new EngineUnavailableError(
          `could not write ${pending.length} documents to ${index}: too many conflicts`,
        );
      const got = await this.engine.mget(
        index,
        pending.map((p) => p.id),
      );
      const stored = new Map<string, MgetDoc>(
        (got.docs as MgetDoc[]).map((d) => [d._id, d]),
      );
      const operations: object[] = [];
      const written: { id: string; mutation: Mutation }[] = [];
      for (const item of pending) {
        const doc = stored.get(item.id);
        const current = doc?.found ? toStored(item.id, doc._source) : null;
        const result = item.mutation(current);
        outcomes.set(item.id, result.outcome);
        // an equal-version redelivery that changes nothing is not written again: one logical write (AS-24)
        if (
          !result.next ||
          (current && isDeepStrictEqual(current, result.next))
        )
          continue;
        operations.push(
          doc?.found
            ? {
                index: {
                  _index: index,
                  _id: item.id,
                  if_seq_no: doc._seq_no,
                  if_primary_term: doc._primary_term,
                },
              }
            : { create: { _index: index, _id: item.id } },
          result.next,
        );
        written.push(item);
      }
      if (operations.length === 0) return outcomes;
      const res = await this.engine.bulk(operations);
      const retry: { id: string; mutation: Mutation }[] = [];
      (res.items as Record<string, BulkResultItem>[]).forEach((entry, i) => {
        const r = entry.index ?? entry.create ?? entry.update;
        if (!r?.error) return;
        if (r.error.type === CONFLICT || r.status === 409) {
          retry.push(written[i]);
          return;
        }
        const detail = `search engine rejected a write to ${index} (${r.status}, ${r.error.type})`;
        throw (r.status ?? 0) >= 500 || r.status === 429
          ? new EngineUnavailableError(detail)
          : new EngineRejectedError(detail, r.status, r.error.type);
      });
      pending = retry;
    }
    return outcomes;
  }

  async search(request: EngineSearchRequest): Promise<EngineSearchResult> {
    if (request.vector) return this.searchNearest(request, request.vector);
    const facets = request.facets === true;
    const res = await this.engine.search(
      {
        index: PRODUCTS_ALIAS,
        size: request.limit + 1,
        track_total_hits: TOTAL_HITS_CAP + 1,
        timeout: `${Math.max(100, this.settings.searchBudgetMs - 100)}ms`,
        _source: LIST_FIELDS,
        // with facets the selections move out of the query into a post filter, so the facets see all matches
        query: this.queryOf(request, !facets),
        ...(facets
          ? {
              post_filter: {
                bool: { filter: this.selectionClauses(request.filters) },
              },
              aggs: this.facetAggregations(request.filters),
            }
          : {}),
        sort: this.sortOf(request),
        ...(request.after ? { search_after: request.after } : {}),
      },
      { timeoutMs: this.settings.searchBudgetMs, maxRetries: 0 },
    );
    const total = res.hits?.total ?? { value: 0, relation: 'eq' };
    return {
      hits: (res.hits?.hits ?? []).map(
        (h: { _id: string; sort: (string | number)[]; _source: object }) => ({
          id: h._id,
          sort: h.sort,
          source: h._source,
        }),
      ),
      total: {
        value: Math.min(total.value, TOTAL_HITS_CAP),
        exact: total.relation === 'eq' && total.value <= TOTAL_HITS_CAP,
      },
      ...(facets ? { facets: this.facetsOf(res.aggregations) } : {}),
    };
  }

  /** k-NN over the visible, filtered documents that have a vector; no lexical clause, no paging. */
  private async searchNearest(
    request: EngineSearchRequest,
    vector: number[],
  ): Promise<EngineSearchResult> {
    const k = request.limit;
    const res = await this.engine.search(
      {
        index: PRODUCTS_ALIAS,
        size: k,
        timeout: `${Math.max(100, this.settings.searchBudgetMs - 100)}ms`,
        _source: LIST_FIELDS,
        knn: {
          field: 'embedding',
          query_vector: vector,
          k,
          num_candidates: Math.max(100, k * 10),
          filter: {
            bool: {
              filter: [
                ...visibilityFilter(),
                ...this.alwaysClauses(request.filters),
                ...this.selectionClauses(request.filters),
              ],
            },
          },
        },
      },
      { timeoutMs: this.settings.searchBudgetMs, maxRetries: 0 },
    );
    const hits = (res.hits?.hits ?? []) as { _id: string; _source: object }[];
    return {
      hits: hits.map((h) => ({ id: h._id, sort: [], source: h._source })),
      total: { value: hits.length, exact: true },
    };
  }

  suggestTitles(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    return this.titlesMatching(
      { 'title.autocomplete': { query: prefix, operator: 'and' } },
      size,
      signal,
    );
  }

  suggestTitlesFuzzy(
    prefix: string,
    size: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    // every word may carry a typo, the last one is still being typed. `match_bool_prefix` alone leaves the last word a
    // plain prefix (no typo allowed), so a single misspelled word needs the fuzzy `match` alongside it.
    const title = {
      query: prefix,
      operator: 'and',
      fuzziness: 'AUTO',
      prefix_length: 1,
      max_expansions: 50,
    };
    return this.titlesMatching(
      {
        should: [{ match_bool_prefix: { title } }, { match: { title } }],
        minimum_should_match: 1,
      },
      size,
      signal,
      'bool',
    );
  }

  private async titlesMatching(
    match: object,
    size: number,
    signal?: AbortSignal,
    clause: 'match' | 'match_bool_prefix' | 'bool' = 'match',
  ): Promise<string[]> {
    const res = await this.engine.search(
      {
        index: PRODUCTS_ALIAS,
        size,
        _source: ['title'],
        query: {
          bool: {
            filter: visibilityFilter(),
            must: [{ [clause]: match }],
          },
        },
      },
      { timeoutMs: this.settings.searchBudgetMs, maxRetries: 0, signal },
    );
    return ((res.hits?.hits ?? []) as { _source?: { title?: string } }[])
      .map((h) => h._source?.title)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
  }

  /** Filters that narrow every facet too (stock and rating). */
  private alwaysClauses(f: EngineSearchRequest['filters']): object[] {
    const out: object[] = [];
    if (f.inStock !== undefined) out.push({ term: { inStock: f.inStock } });
    if (f.minRating !== undefined)
      out.push({ range: { rating: { gte: f.minRating } } });
    return out;
  }

  /** The filters picked in the facet panel; `except` leaves one group out (the facet of that group). */
  private selectionClauses(
    f: EngineSearchRequest['filters'],
    except?: Selection,
  ): object[] {
    const out: object[] = [];
    if (f.category && except !== 'category')
      out.push({ term: { category: f.category } });
    if (f.brand && except !== 'brand')
      out.push({ term: { 'brand.keyword': f.brand } });
    if (
      (f.minPriceMinor !== undefined || f.maxPriceMinor !== undefined) &&
      except !== 'price'
    )
      out.push({
        range: {
          priceMinor: {
            ...(f.minPriceMinor !== undefined && { gte: f.minPriceMinor }),
            ...(f.maxPriceMinor !== undefined && { lte: f.maxPriceMinor }),
          },
        },
      });
    return out;
  }

  /** One `filter` aggregation per facet holding every selection except its own. */
  private facetAggregations(f: EngineSearchRequest['filters']): object {
    const scoped = (except: Selection | undefined, aggs: object) => ({
      filter: { bool: { filter: this.selectionClauses(f, except) } },
      aggs,
    });
    const top = (field: string) => ({
      terms: {
        field,
        size: FACET_SIZE,
        shard_size: FACET_SIZE * 5,
        order: [{ _count: 'desc' }, { _key: 'asc' }],
      },
    });
    return {
      categories: scoped('category', { top: top('category') }),
      brands: scoped('brand', { top: top('brand.keyword') }),
      priceRanges: scoped('price', {
        top: {
          range: {
            field: 'priceMinor',
            keyed: true,
            ranges: [
              { key: 'under_25', to: 2_500 },
              { key: '25_to_50', from: 2_500, to: 5_000 },
              { key: '50_to_100', from: 5_000, to: 10_000 },
              { key: 'over_100', from: 10_000 },
            ],
          },
        },
      }),
      rating: scoped(undefined, { avg: { avg: { field: 'rating' } } }),
    };
  }

  private facetsOf(aggs: FacetAggregations | undefined): FacetCounts {
    const buckets = (name: 'categories' | 'brands') =>
      (aggs?.[name]?.top?.buckets ?? []).map((b) => ({
        key: String(b.key),
        count: b.doc_count,
      }));
    const ranges = aggs?.priceRanges?.top?.buckets ?? {};
    const avg = aggs?.rating?.avg?.value;
    return {
      categories: buckets('categories'),
      brands: buckets('brands'),
      priceRanges: PRICE_RANGE_KEYS.map((key) => ({
        key,
        count: ranges[key]?.doc_count ?? 0,
      })),
      avgRating: typeof avg === 'number' ? Math.round(avg * 100) / 100 : null,
    };
  }

  private queryOf(
    request: EngineSearchRequest,
    withSelections: boolean,
  ): object {
    const f = request.filters;
    const filter: object[] = [
      ...visibilityFilter(),
      ...this.alwaysClauses(f),
      ...(withSelections ? this.selectionClauses(f) : []),
    ];
    if (request.q === null) return { bool: { filter } };
    // The text goes into a plain `multi_match` string, never `query_string`: operators and wildcards are words.
    return {
      function_score: {
        query: {
          bool: {
            filter,
            must: [
              {
                multi_match: {
                  query: request.q,
                  fields: ['title^4', 'brand^2', 'description', 'tags^0.5'],
                  fuzziness: 'AUTO',
                  prefix_length: 1,
                  max_expansions: 50,
                },
              },
            ],
            should: [
              { match_phrase: { title: { query: request.q, boost: 2 } } },
            ],
          },
        },
        // the precomputed business multiplier, already capped at 4: text relevance stays dominant
        functions: [
          { field_value_factor: { field: 'browseScore', missing: 1 } },
        ],
        boost_mode: 'multiply',
      },
    };
  }

  private sortOf(request: EngineSearchRequest): object[] {
    const tie = { productId: 'asc' };
    switch (request.sort) {
      case 'price-asc':
        return [{ priceMinor: 'asc' }, tie];
      case 'price-desc':
        return [{ priceMinor: 'desc' }, tie];
      case 'newest':
        return [{ createdAt: 'desc' }, tie];
      case 'relevance':
        return request.q === null
          ? [{ browseScore: 'desc' }, tie]
          : [{ _score: 'desc' }, tie];
      default:
        return assertNever(request.sort);
    }
  }

  async stampShop(shopId: string, stamp: ShopStampWrite): Promise<void> {
    const weights = this.settings.boostWeights;
    const tierFactor = tierFactorOf(stamp.tier, weights);
    for (const index of await this.registry.writeSet()) {
      // Documents indexed a moment ago are not searchable until a refresh; the update only sees searchable ones.
      await this.engine.refresh(index);
      for (let pass = 0; pass < 4; pass++) {
        const { versionConflicts } = await this.engine.updateByQuery({
          index,
          query: { term: { shopId } },
          script: {
            lang: 'painless',
            source: STAMP_SCRIPT,
            params: {
              status: stamp.status,
              hidden: stamp.hidden,
              tier: stamp.tier,
              version: stamp.version,
              at: stamp.at,
              tierFactor,
              cap: MAX_BOOST_MULTIPLIER,
            },
          },
        });
        if (versionConflicts === 0) break;
      }
    }
  }

  async purgeShop(shopId: string): Promise<void> {
    for (const index of await this.registry.writeSet()) {
      await this.engine.refresh(index);
      for (let pass = 0; pass < 4; pass++) {
        await this.engine.deleteByQuery({
          index,
          query: { term: { shopId } },
        });
        await this.engine.refresh(index);
        if ((await this.engine.count(index, { term: { shopId } })) === 0) break;
      }
    }
  }

  async purgeTombstones(before: Date): Promise<number> {
    let removed = 0;
    for (const [i, index] of (await this.registry.writeSet()).entries()) {
      await this.engine.refresh(index);
      const { deleted } = await this.engine.deleteByQuery({
        index,
        query: {
          bool: {
            filter: [
              { term: { deleted: true } },
              { range: { deletedAt: { lt: before.toISOString() } } },
            ],
          },
        },
      });
      if (i === 0) removed = deleted;
    }
    return removed;
  }

  async popularProductIds(
    after: string | null,
    limit: number,
  ): Promise<string[]> {
    const res = await this.engine.search({
      index: PRODUCTS_ALIAS,
      size: 0,
      query: { range: { popularityBucket: { gt: 0 } } },
      aggs: {
        products: {
          composite: {
            size: limit,
            sources: [{ id: { terms: { field: 'productId' } } }],
            ...(after ? { after: { id: after } } : {}),
          },
        },
      },
    });
    return (res.aggregations?.products?.buckets ?? []).map(
      (b: { key: { id: string } }) => b.key.id,
    );
  }

  async pendingEmbeddingIds(limit: number): Promise<string[]> {
    const res = await this.engine.search({
      index: PRODUCTS_ALIAS,
      size: limit,
      _source: false,
      query: {
        bool: {
          filter: [
            { term: { embeddingPending: true } },
            { term: { hasProduct: true } },
            { term: { deleted: false } },
          ],
        },
      },
      sort: [{ productId: 'asc' }],
    });
    return (res.hits?.hits ?? []).map((h: { _id: string }) => h._id);
  }

  async distinctShopIds(
    after: string | null,
    limit: number,
  ): Promise<string[]> {
    const res = await this.engine.search({
      index: PRODUCTS_ALIAS,
      size: 0,
      aggs: {
        shops: {
          composite: {
            size: limit,
            sources: [{ shop: { terms: { field: 'shopId' } } }],
            ...(after ? { after: { shop: after } } : {}),
          },
        },
      },
    });
    return (res.aggregations?.shops?.buckets ?? []).map(
      (b: { key: { shop: string } }) => b.key.shop,
    );
  }
}

/**
 * Shop state stamped onto the documents of a shop, guarded like `decideShopState` (own version when both sides have
 * one, else the time) and recomputing the score as `browseBase` times the tier factor, capped.
 */
const STAMP_SCRIPT = `
  boolean newer;
  if (ctx._source.shopStateAt == null) {
    newer = true;
  } else if (ctx._source.shopStateVersion != null && params.version != null && params.version != ctx._source.shopStateVersion) {
    newer = params.version > ctx._source.shopStateVersion;
  } else {
    newer = params.at.compareTo(ctx._source.shopStateAt) > 0;
  }
  if (!newer) {
    ctx.op = 'noop';
  } else {
    ctx._source.shopStatus = params.status;
    ctx._source.shopHidden = params.hidden;
    ctx._source.shopTier = params.tier;
    ctx._source.shopStateVersion = params.version;
    ctx._source.shopStateAt = params.at;
    double base = ctx._source.browseBase == null ? 1.0 : ctx._source.browseBase;
    ctx._source.browseScore = Math.min(params.cap, base * params.tierFactor);
  }
`;
