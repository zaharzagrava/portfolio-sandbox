import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import {
  KnowledgeConfig,
  knowledgeConfigKeys,
  knowledgeProductionRule,
} from '@app/common/config/knowledge-config';

const parse = (env: Record<string, string>): KnowledgeConfig =>
  new ConfigUtilsService().parseSrc<KnowledgeConfig>(knowledgeConfigKeys, [
    env as unknown as Record<string, KnowledgeConfig[keyof KnowledgeConfig]>,
  ]);

describe('S47 G41: knowledge configuration', () => {
  it('S47 G41: defaults are the spec values when nothing is set', () => {
    expect(parse({})).toMatchObject({
      rag_min_similarity: 0.3,
      rag_candidates: 40,
      rag_top_k: 6,
      rag_query_embed_timeout_ms: 3_000,
      rag_retrieval_timeout_ms: 2_000,
      rag_first_token_timeout_ms: 30_000,
      rag_answer_timeout_ms: 60_000,
      knowledge_max_documents_per_shop: 1_000,
      knowledge_max_pages: 500,
      knowledge_processing_lease_ms: 300_000,
      knowledge_upload_ttl_s: 900,
      knowledge_max_receives: 5,
      knowledge_ingest_concurrency: 4,
      knowledge_embed_batch: 128,
      rag_eval_min_recall: 0.8,
      rag_model: 'claude-sonnet-5-5',
    });
  });

  it('S47 G41: values from the environment are used', () => {
    expect(
      parse({
        RAG_MIN_SIMILARITY: '0.5',
        KNOWLEDGE_MAX_DOCUMENTS_PER_SHOP: '3',
        RAG_MODEL: 'claude-haiku-5-5',
        RAG_QUERY_EMBED_TIMEOUT_MS: '200',
        MODERATION_BACKEND: 'openai',
      }),
    ).toMatchObject({
      rag_min_similarity: 0.5,
      knowledge_max_documents_per_shop: 3,
      rag_model: 'claude-haiku-5-5',
      rag_query_embed_timeout_ms: 200,
      moderation_backend: 'openai',
    });
  });

  it.each([
    ['RAG_MIN_SIMILARITY', '1.5'],
    ['RAG_MIN_SIMILARITY', '-0.1'],
    ['RAG_MIN_SIMILARITY', 'high'],
    ['RAG_CANDIDATES', '0'],
    ['RAG_CANDIDATES', '1001'],
    ['RAG_TOP_K', '0'],
    ['RAG_TOP_K', '21'],
    ['RAG_QUERY_EMBED_TIMEOUT_MS', '0'],
    ['RAG_RETRIEVAL_TIMEOUT_MS', '-5'],
    ['RAG_FIRST_TOKEN_TIMEOUT_MS', 'soon'],
    ['RAG_ANSWER_TIMEOUT_MS', '1.5'],
    ['KNOWLEDGE_MAX_DOCUMENTS_PER_SHOP', '0'],
    ['KNOWLEDGE_MAX_PAGES', '0'],
    ['KNOWLEDGE_PROCESSING_LEASE_MS', '0'],
    ['KNOWLEDGE_UPLOAD_TTL_S', '901'],
    ['KNOWLEDGE_MAX_RECEIVES', '0'],
    ['KNOWLEDGE_INGEST_CONCURRENCY', '0'],
    ['KNOWLEDGE_EMBED_BATCH', '0'],
    ['KNOWLEDGE_EMBED_BATCH', '129'],
    ['RAG_EVAL_MIN_RECALL', '1.2'],
  ])(
    'S47 G41: %s=%s is refused and the message names the key, not the value',
    (key, value) => {
      let message = '';
      try {
        parse({ [key]: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message.toLowerCase()).toContain(key.toLowerCase());
      expect(message).not.toContain(`"${value}"`);
    },
  );

  describe('production rule (AS-54)', () => {
    const good = {
      voyage_api_key: 'pa-key',
      moderation_backend: 'openai',
      knowledge_cursor_key: 'k'.repeat(32),
    };
    const run = (values: Record<string, unknown>, production = true) =>
      knowledgeProductionRule({
        get: (key) => values[key],
        production,
      });

    it('S47 AS-54: accepts a complete production configuration', () => {
      expect(run(good)).toEqual([]);
    });

    it.each([
      ['voyage_api_key', { voyage_api_key: undefined }],
      ['voyage_api_key', { voyage_api_key: '' }],
      ['moderation_backend', { moderation_backend: undefined }],
      ['knowledge_cursor_key', { knowledge_cursor_key: undefined }],
      ['knowledge_cursor_key', { knowledge_cursor_key: 'short' }],
    ])(
      'S47 AS-54: production without %s fails naming the key',
      (key, change) => {
        const found = run({ ...good, ...change });
        expect(found.some((m) => m.includes(key))).toBe(true);
        expect(found.join(' ')).not.toContain('short');
      },
    );

    it('S47 AS-54: outside production nothing is required', () => {
      expect(run({}, false)).toEqual([]);
    });
  });
});
