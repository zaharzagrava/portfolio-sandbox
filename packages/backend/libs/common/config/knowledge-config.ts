import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of the knowledge half of `assistant` (S47 G38, G41, R-13). Defaults are applied here (the loader
 * keeps the raw value); an invalid value fails startup naming the key, never the value. Production refuses a missing
 * embedding key, a missing moderation backend and a missing or short cursor key (AS-54).
 */
export interface KnowledgeConfig {
  voyage_api_key?: string;
  /** Embedding model name, 1,024 dimensions. Default voyage-3.5. */
  voyage_model: string;
  /** Meaning hits below this cosine similarity count only when the keyword search also found them. */
  rag_min_similarity: number;
  /** Candidates per list before fusion. */
  rag_candidates: number;
  /** Passages kept after fusion. */
  rag_top_k: number;
  rag_query_embed_timeout_ms: number;
  rag_retrieval_timeout_ms: number;
  rag_first_token_timeout_ms: number;
  rag_answer_timeout_ms: number;
  /** Model that writes the answers (short grounded answers use a cheaper tier than the assistant). */
  rag_model: string;
  rag_eval_min_recall: number;
  knowledge_max_documents_per_shop: number;
  knowledge_max_pages: number;
  knowledge_processing_lease_ms: number;
  /** Lifetime of a PDF upload grant; at most 15 minutes. */
  knowledge_upload_ttl_s: number;
  /** Receives before a task is dead-lettered; equals `maxReceiveCount` of the queue in `elasticmq.conf`. */
  knowledge_max_receives: number;
  knowledge_ingest_concurrency: number;
  knowledge_embed_batch: number;
  /** Moderation backend bound by the platform (S46 supplies the port); required in production. */
  moderation_backend?: string;
  /** Signs list cursors; at least 32 bytes in production. */
  knowledge_cursor_key?: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const num = (
  name: string,
  fallback: number,
  schema: joi.NumberSchema,
): Key => ({
  name,
  verify: schema.required(),
  postProcess: ((v: unknown) =>
    v === undefined || v === '' ? fallback : Number(v)) as never,
});
const int = (name: string, fallback: number, min = 1, max?: number): Key => {
  let schema = joi.number().integer().min(min);
  if (max !== undefined) schema = schema.max(max);
  return num(name, fallback, schema);
};
const text = (name: string, fallback: string): Key => ({
  name,
  verify: joi.string().min(1).required(),
  postProcess: ((v: unknown) =>
    v === undefined || v === '' ? fallback : (v as string)) as never,
});
const optionalText = (name: string): Key => ({
  name,
  verify: joi.string().optional().allow(''),
});

export const knowledgeConfigKeys: Record<keyof KnowledgeConfig, Key> = {
  voyage_api_key: optionalText('VOYAGE_API_KEY'),
  voyage_model: text('VOYAGE_MODEL', 'voyage-3.5'),
  rag_min_similarity: num(
    'RAG_MIN_SIMILARITY',
    0.3,
    joi.number().min(0).max(1),
  ),
  rag_candidates: int('RAG_CANDIDATES', 40, 1, 1_000),
  rag_top_k: int('RAG_TOP_K', 6, 1, 20),
  rag_query_embed_timeout_ms: int('RAG_QUERY_EMBED_TIMEOUT_MS', 3_000),
  rag_retrieval_timeout_ms: int('RAG_RETRIEVAL_TIMEOUT_MS', 2_000),
  rag_first_token_timeout_ms: int('RAG_FIRST_TOKEN_TIMEOUT_MS', 30_000),
  rag_answer_timeout_ms: int('RAG_ANSWER_TIMEOUT_MS', 60_000),
  rag_model: text('RAG_MODEL', 'claude-sonnet-5-5'),
  rag_eval_min_recall: num(
    'RAG_EVAL_MIN_RECALL',
    0.8,
    joi.number().min(0).max(1),
  ),
  knowledge_max_documents_per_shop: int(
    'KNOWLEDGE_MAX_DOCUMENTS_PER_SHOP',
    1_000,
  ),
  knowledge_max_pages: int('KNOWLEDGE_MAX_PAGES', 500),
  knowledge_processing_lease_ms: int('KNOWLEDGE_PROCESSING_LEASE_MS', 300_000),
  knowledge_upload_ttl_s: int('KNOWLEDGE_UPLOAD_TTL_S', 900, 1, 900),
  knowledge_max_receives: int('KNOWLEDGE_MAX_RECEIVES', 5, 1, 100),
  knowledge_ingest_concurrency: int('KNOWLEDGE_INGEST_CONCURRENCY', 4, 1, 64),
  knowledge_embed_batch: int('KNOWLEDGE_EMBED_BATCH', 128, 1, 128),
  moderation_backend: optionalText('MODERATION_BACKEND'),
  knowledge_cursor_key: optionalText('KNOWLEDGE_CURSOR_KEY'),
};

/** Fallback signing key outside production (the cursor is not a secret there); production must set its own. */
export const DEV_KNOWLEDGE_CURSOR_KEY =
  'dev-knowledge-cursor-key-0123456789abcdef';

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/** AS-54: messages name keys and the broken rule, never a value. */
export const knowledgeProductionRule: RuleCheck = (ctx) => {
  if (!ctx.production) return [];
  const found: string[] = [];
  if (!isSet(ctx.get('voyage_api_key')))
    found.push(
      'voyage_api_key is required in production (without it the deterministic test embedder would be used)',
    );
  if (!isSet(ctx.get('moderation_backend')))
    found.push('moderation_backend is required in production');
  const cursor = ctx.get('knowledge_cursor_key');
  if (!isSet(cursor))
    found.push('knowledge_cursor_key is required in production');
  else if (Buffer.byteLength(String(cursor)) < 32)
    found.push('knowledge_cursor_key must be at least 32 bytes');
  return found;
};

ConfigRules.register({
  owner: 'knowledge',
  keys: ['voyage_api_key', 'moderation_backend', 'knowledge_cursor_key'],
  validate: knowledgeProductionRule,
});
