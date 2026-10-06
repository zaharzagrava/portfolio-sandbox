import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Client } from '@elastic/elasticsearch';
import { ApiConfigService } from '@app/common/config/api-config.service';
import {
  PRODUCT_EMBEDDING_DIMS,
  ProductSearchParams,
  ProductSearchResult,
  UpsertProductDocument,
} from './types';

export const PRODUCTS_INDEX = 'products';
export const SYNONYMS_SET = 'product-synonyms';
const DEFAULT_SYNONYMS = ['airpods, earbuds, wireless headphones', 'phone, smartphone, mobile', 'laptop, notebook', 'tv, television', 'sneakers, trainers'];

@Injectable()
export class ElasticsearchService implements OnModuleInit {
  private readonly l = new Logger(ElasticsearchService.name);
  private readonly client: Client;

  constructor(private readonly configService: ApiConfigService) {
    this.client = new Client({
      node: this.configService.get('elasticsearch_node'),
    });
  }

  async onModuleInit() {
    try {
      await this.ensureProductsIndex();
      this.l.log(
        `Elasticsearch ready at ${this.configService.get('elasticsearch_node')}`,
      );
    } catch (error: any) {
      this.l.warn(`Elasticsearch init skipped: ${error?.message ?? error}`);
    }
  }

  public getClient(): Client {
    return this.client;
  }

  /**
   * Creates the products index with analyzers for fuzzy, BM25 boosts,
   * edge-ngram autocomplete, facets, and dense_vector k-NN.
   * // See README.md#adr -> "Why use Elasticsearch instead of Postgres for product search?"
   */
  /**
   * `products` is an ALIAS over a versioned physical index (SD-37), so a
   * mapping change is a zero-downtime reindex + atomic alias swap instead of
   * "delete and rebuild while search is down". Pre-SD-37 deployments have a
   * concrete `products` index; the first reindex migrates it.
   */
  public async ensureProductsIndex(): Promise<void> {
    const exists = await this.client.indices.exists({ index: PRODUCTS_INDEX });
    if (exists) return;

    await this.ensureSynonymsSet();
    const physical = `${PRODUCTS_INDEX}_v${Date.now()}`;
    await this.client.indices.create({ index: physical, ...this.productsIndexDefinition(), aliases: { [PRODUCTS_INDEX]: { is_write_index: true } } });
    this.l.log(`Created Elasticsearch index [${physical}] behind alias [${PRODUCTS_INDEX}]`);
  }

  /** Search-time synonyms via the Synonyms API: editable without reindexing ("airpods" ↔ "earbuds"). */
  public async ensureSynonymsSet(rules: string[] = DEFAULT_SYNONYMS): Promise<void> {
    const exists = await this.client.synonyms.getSynonym({ id: SYNONYMS_SET }).then(() => true).catch(() => false);
    if (!exists) await this.client.synonyms.putSynonym({ id: SYNONYMS_SET, synonyms_set: rules.map((synonyms) => ({ synonyms })) });
  }

  public async updateSynonyms(rules: string[]): Promise<void> {
    // putSynonym reloads every search analyzer using the set - no index close, no reindex.
    await this.client.synonyms.putSynonym({ id: SYNONYMS_SET, synonyms_set: rules.map((synonyms) => ({ synonyms })) });
  }

  public productsIndexDefinition() {
    return {
      settings: {
        refresh_interval: '5s',
        analysis: {
          analyzer: {
            autocomplete_index: {
              type: 'custom',
              tokenizer: 'standard',
              filter: ['lowercase', 'autocomplete_edge'],
            },
            autocomplete_search: {
              type: 'custom',
              tokenizer: 'standard',
              filter: ['lowercase'],
            },
            search_synonyms: {
              type: 'custom',
              tokenizer: 'standard',
              filter: ['lowercase', 'product_synonyms'],
            },
          },
          filter: {
            // See README.md#adr -> "Why use Edge N-Grams for Autocomplete?"
            autocomplete_edge: {
              type: 'edge_ngram',
              min_gram: 2,
              max_gram: 20,
            },
            product_synonyms: { type: 'synonym_graph', synonyms_set: SYNONYMS_SET, updateable: true },
          },
        },
      },
      mappings: {
        properties: {
          title: {
            type: 'text',
            analyzer: 'standard',
            search_analyzer: 'search_synonyms',
            fields: {
              autocomplete: {
                type: 'text',
                analyzer: 'autocomplete_index',
                search_analyzer: 'autocomplete_search',
              },
              keyword: { type: 'keyword' },
            },
          },
          description: { type: 'text', analyzer: 'standard', search_analyzer: 'search_synonyms' },
          brand: {
            type: 'text',
            fields: { keyword: { type: 'keyword' } },
          },
          category: { type: 'keyword' },
          price: { type: 'long' },
          rating: { type: 'float' },
          tags: { type: 'keyword' },
          inStock: { type: 'boolean' },
          popularity: { type: 'long' },
          createdAt: { type: 'date' },
          embedding: {
            type: 'dense_vector',
            dims: PRODUCT_EMBEDDING_DIMS,
            index: true,
            similarity: 'cosine',
          },
        },
      },
    } as const;
  }

  /**
   * Batched equivalent of upsertProduct — one HTTP request to Elasticsearch's
   * /_bulk API regardless of batch size, built to survive load-test-level
   * bursts without one round-trip per product.
   */
  public async bulkUpsertProducts(
    docs: UpsertProductDocument[],
    { refresh = true }: { refresh?: boolean } = {},
  ): Promise<void> {
    if (docs.length === 0) return;

    const operations = docs.flatMap((doc) => [
      {
        index: {
          _index: PRODUCTS_INDEX,
          _id: doc.id,
          ...(doc.version !== undefined && { version: doc.version, version_type: 'external_gte' as const }),
        },
      },
      {
        title: doc.title,
        description: doc.description,
        brand: doc.brand,
        category: doc.category,
        price: doc.price,
        rating: doc.rating,
        tags: doc.tags ?? [],
        embedding: doc.embedding,
        ...(doc.inStock !== undefined && { inStock: doc.inStock }),
        ...(doc.popularity !== undefined && { popularity: doc.popularity }),
        ...(doc.createdAt !== undefined && { createdAt: doc.createdAt }),
      },
    ]);

    // Projectors pass refresh=false: forcing a refresh per bulk at high write
    // rates creates tiny segments; the index refresh_interval makes docs visible.
    const response = await this.client.bulk({ operations, refresh });

    if (response.errors) {
      // Version conflicts are expected (a newer version is already indexed) - not failures.
      const failedItems = (response.items ?? []).filter(
        (item: any) => item.index?.error && item.index.error.type !== 'version_conflict_engine_exception',
      );
      if (failedItems.length === 0) return;
      this.l.warn(
        `Bulk product index had ${failedItems.length} failures out of ${docs.length}`,
        { failedItems },
      );
    }
  }

  public async upsertProduct(doc: UpsertProductDocument): Promise<void> {
    await this.client.index({
      index: PRODUCTS_INDEX,
      id: doc.id,
      document: {
        title: doc.title,
        description: doc.description,
        brand: doc.brand,
        category: doc.category,
        price: doc.price,
        rating: doc.rating,
        tags: doc.tags ?? [],
        embedding: doc.embedding,
        ...(doc.createdAt !== undefined && { createdAt: doc.createdAt }),
      },
      refresh: true,
    });
  }

  /**
   * Showcase search: fuzzy multi-match + field boosts + range filters +
   * optional facets + optional k-NN + autocomplete suggestions.
   */
  /** Product-title completions only (edge n-grams, README #15) - the cheap half of `searchProducts` used by SD-12 /suggest. */
  public async suggestTitles(prefix: string, size = 5, signal?: AbortSignal): Promise<string[]> {
    const response = await this.client.search(
      { index: PRODUCTS_INDEX, size, query: { match: { 'title.autocomplete': { query: prefix, operator: 'and' } } }, _source: ['title'] },
      { signal },
    );
    return (response.hits.hits ?? []).map((h) => (h._source as { title?: string } | undefined)?.title).filter((t): t is string => Boolean(t));
  }

  public async searchProducts(
    params: ProductSearchParams,
  ): Promise<ProductSearchResult> {
    const {
      q,
      priceMin,
      priceMax,
      ratingMin,
      category,
      brand,
      facets = false,
      semantic = false,
      sort,
      size = 20,
      from = 0,
    } = params;

    const filter: Record<string, any>[] = [];
    if (priceMin != null || priceMax != null) {
      filter.push({
        range: {
          price: {
            ...(priceMin != null && { gte: priceMin }),
            ...(priceMax != null && { lte: priceMax }),
          },
        },
      });
    }
    if (ratingMin != null) {
      filter.push({ range: { rating: { gte: ratingMin } } });
    }
    if (category) {
      filter.push({ term: { category } });
    }
    if (brand) {
      filter.push({ term: { 'brand.keyword': brand } });
    }

    const must: Record<string, any>[] = [];
    if (q?.trim() && !semantic) {
      // See README.md#adr -> "Why is fuzzy search important?"
      must.push({
        multi_match: {
          query: q,
          fields: ['title^3', 'brand^2', 'description', 'tags'],
          fuzziness: 'AUTO',
          operator: 'or',
        },
      });
    }

    const relevance = {
      bool: {
        must: must.length ? must : [{ match_all: {} }],
        filter,
      },
    };

    // SD-37 business boosts on top of BM25: in-stock first, then quality and popularity
    // (log-damped so a viral product can't bury every exact match).
    const body: Record<string, any> = {
      from,
      size,
      query: {
        function_score: {
          query: relevance,
          functions: [
            { filter: { term: { inStock: true } }, weight: 2 },
            { field_value_factor: { field: 'rating', modifier: 'log1p', factor: 1, missing: 0 } },
            { field_value_factor: { field: 'popularity', modifier: 'log1p', factor: 0.1, missing: 0 } },
          ],
          score_mode: 'sum',
          boost_mode: 'multiply',
        },
      },
    };

    if (sort === 'price-asc') {
      body.sort = [{ price: 'asc' }, '_score'];
    } else if (sort === 'price-desc') {
      body.sort = [{ price: 'desc' }, '_score'];
    } else if (sort === 'newest') {
      body.sort = [{ createdAt: 'desc' }, '_score'];
    }

    if (facets) {
      body.aggs = {
        categories: { terms: { field: 'category', size: 20 } },
        brands: { terms: { field: 'brand.keyword', size: 20 } },
        price_ranges: {
          range: {
            field: 'price',
            ranges: [
              { key: 'under_25', to: 2500 },
              { key: '25_to_50', from: 2500, to: 5000 },
              { key: '50_to_100', from: 5000, to: 10000 },
              { key: 'over_100', from: 10000 },
            ],
          },
        },
        avg_rating: { avg: { field: 'rating' } },
      };
    }

    if (semantic && q?.trim()) {
      // See README.md#adr -> "Why use Semantic Vector Search (k-NN)?"
      body.knn = {
        field: 'embedding',
        query_vector: this.stubEmbed(q),
        k: size,
        num_candidates: Math.max(size * 5, 50),
        ...(filter.length ? { filter: { bool: { filter } } } : {}),
      };
    }

    const response = await this.client.search({
      index: PRODUCTS_INDEX,
      ...body,
    });

    let suggestions: string[] = [];
    if (q?.trim()) {
      const suggestResponse = await this.client.search({
        index: PRODUCTS_INDEX,
        size: 8,
        query: {
          bool: {
            must: [
              {
                match: {
                  'title.autocomplete': {
                    query: q,
                    operator: 'and',
                  },
                },
              },
            ],
            filter,
          },
        },
        _source: ['title'],
      });
      suggestions = (suggestResponse.hits.hits ?? [])
        .map((hit) => (hit._source as { title?: string } | undefined)?.title)
        .filter((title): title is string => Boolean(title));
    }

    const hits = (response.hits.hits ?? []).map((hit) => ({
      id: String(hit._id),
      score: hit._score ?? 0,
      source: hit._source as ProductSearchResult['hits'][number]['source'],
    }));

    const aggs = response.aggregations as Record<string, any> | undefined;

    return {
      total:
        typeof response.hits.total === 'number'
          ? response.hits.total
          : (response.hits.total?.value ?? hits.length),
      hits,
      suggestions,
      facets: facets
        ? {
          categories: this.bucketKeys(aggs?.categories),
          brands: this.bucketKeys(aggs?.brands),
          priceRanges: this.bucketKeys(aggs?.price_ranges),
          avgRating: aggs?.avg_rating?.value ?? null,
        }
        : undefined,
    };
  }

  /** Deterministic fake embedding so k-NN works without an ML model. */
  public stubEmbed(text: string): number[] {
    const dims = PRODUCT_EMBEDDING_DIMS;
    const vec = new Array<number>(dims).fill(0);
    const normalized = text.toLowerCase();
    for (let i = 0; i < normalized.length; i++) {
      const code = normalized.charCodeAt(i);
      vec[i % dims] += (code % 31) / 31;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  private bucketKeys(agg: any): { key: string; count: number }[] {
    if (!agg?.buckets) return [];
    return agg.buckets.map((b: any) => ({
      key: String(b.key),
      count: b.doc_count as number,
    }));
  }
}
