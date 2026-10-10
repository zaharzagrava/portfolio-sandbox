/** Public products index definition (data-model section 2). Pure: the adapter hands it to `indices.create`. */
export const MAPPING_VERSION = 1;
export const EMBEDDING_MODEL_VERSION = 'hash-64-v1';
export const EMBEDDING_DIMS = 64;
export const DEFAULT_SYNONYMS_SET = 'product-synonyms';

export interface IndexProfile {
  shards: number;
  replicas: number;
  refreshInterval: string;
  synonymsSet: string;
}

export const PRODUCTION_PROFILE: IndexProfile = {
  shards: 24,
  replicas: 2,
  refreshInterval: '5s',
  synonymsSet: DEFAULT_SYNONYMS_SET,
};

export const TEST_PROFILE: IndexProfile = {
  shards: 1,
  replicas: 0,
  refreshInterval: '1s',
  synonymsSet: DEFAULT_SYNONYMS_SET,
};

export interface IndexMeta {
  mappingVersion: number;
  embeddingModelVersion: string;
  createdByRun: string | null;
}

export function productsIndexDefinition(
  profile: IndexProfile = PRODUCTION_PROFILE,
  createdByRun: string | null = null,
) {
  return {
    settings: {
      number_of_shards: profile.shards,
      number_of_replicas: profile.replicas,
      refresh_interval: profile.refreshInterval,
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
          autocomplete_edge: {
            type: 'edge_ngram',
            min_gram: 2,
            max_gram: 20,
          },
          product_synonyms: {
            type: 'synonym_graph',
            synonyms_set: profile.synonymsSet,
            updateable: true,
          },
        },
      },
    },
    mappings: {
      _meta: {
        mappingVersion: MAPPING_VERSION,
        embeddingModelVersion: EMBEDDING_MODEL_VERSION,
        createdByRun,
      } satisfies IndexMeta,
      properties: {
        productId: { type: 'keyword' },
        shopId: { type: 'keyword' },
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
            raw: { type: 'keyword' },
          },
        },
        brand: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        description: {
          type: 'text',
          analyzer: 'standard',
          search_analyzer: 'search_synonyms',
        },
        tags: { type: 'keyword' },
        category: { type: 'keyword' },
        priceMinor: { type: 'long' },
        currency: { type: 'keyword' },
        rating: { type: 'float' },
        inStock: { type: 'boolean' },
        status: { type: 'keyword' },
        createdAt: { type: 'date' },
        productVersion: { type: 'long' },
        hasProduct: { type: 'boolean' },
        deleted: { type: 'boolean' },
        deletedAt: { type: 'date' },
        embedding: {
          type: 'dense_vector',
          dims: EMBEDDING_DIMS,
          index: true,
          similarity: 'cosine',
        },
        embeddingPending: { type: 'boolean' },
        embeddingTextHash: { type: 'keyword', index: false },
        shopStatus: { type: 'keyword' },
        shopHidden: { type: 'boolean' },
        shopTier: { type: 'keyword' },
        shopStateVersion: { type: 'long' },
        shopStateAt: { type: 'date' },
        imageUrl: { type: 'keyword', index: false },
        galleryVersion: { type: 'long' },
        sponsored: { type: 'boolean' },
        sponsorshipVersion: { type: 'long' },
        popularityBucket: { type: 'byte' },
        popularityAt: { type: 'date' },
        browseBase: { type: 'double' },
        browseScore: { type: 'double' },
      },
    },
  } as const;
}
