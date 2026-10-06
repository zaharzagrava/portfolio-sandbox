import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { createHash } from 'node:crypto';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { Embedder, toVectorLiteral } from './embedder';
import { reciprocalRankFusion } from '../domain/rrf';

export type RetrievalScope =
  /** Buyer asking about a product: that product's public docs + its shop's public, product-less docs (shop FAQ). */
  | { kind: 'product'; productId: string; shopId: string }
  /** Seller help center: platform articles + the shop's own documents (public and private). */
  | { kind: 'shop'; shopId: string };

export interface RetrievedChunk {
  id: string;
  documentId: string;
  title: string;
  headingPath: string;
  page: number | null;
  content: string;
  /** Cosine similarity when the vector search found it, else null (FTS-only hit). */
  similarity: number | null;
  score: number;
}

/** Candidates per retriever before fusion. */
const CANDIDATES = 40;
const QUERY_EMBEDDING_TTL_S = 86_400;

/**
 * The permission filter, as SQL. It is spliced into BOTH candidate queries,
 * so a chunk outside the caller's scope is never a candidate - not filtered
 * out afterwards (a post-filter leaks through counts, timing and bugs, and
 * starves top-k).
 */
function scopeSql(scope: RetrievalScope): { sql: string; replacements: Record<string, string> } {
  switch (scope.kind) {
    case 'product':
      return {
        sql: `c.visibility = 'PUBLIC' AND c."shopId" = :scopeShopId AND (c."productId" = :scopeProductId OR c."productId" IS NULL)`,
        replacements: { scopeShopId: scope.shopId, scopeProductId: scope.productId },
      };
    case 'shop':
      return {
        sql: `(c.visibility = 'PLATFORM' OR (c."shopId" = :scopeShopId AND c.visibility IN ('PUBLIC', 'SHOP_PRIVATE')))`,
        replacements: { scopeShopId: scope.shopId },
      };
  }
}

/**
 * Hybrid retrieval (10/10 #43): HNSW kNN over halfvec embeddings (meaning)
 * + Postgres FTS with ts_rank_cd (exact terms: model numbers, "eSIM", SKU
 * codes that embeddings blur), both in ONE round trip, merged by reciprocal
 * rank fusion. Low-similarity vector hits that FTS doesn't back up are
 * dropped, so an off-topic question yields nothing rather than the "least
 * unrelated" chunks.
 */
@Injectable()
export class Retriever {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly embedder: Embedder,
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  private get minSimilarity() {
    return Number(this.config.get('rag_min_similarity') ?? 0.3);
  }

  async search(scope: RetrievalScope, question: string, k = 6): Promise<RetrievedChunk[]> {
    const embedding = await this.queryEmbedding(question);
    const { sql, replacements } = scopeSql(scope);

    const rows = await this.sequelize.transaction(async (transaction) => {
      // pgvector ≥ 0.8: keep walking the HNSW graph until enough rows pass the scope filter (a selective filter would otherwise return < k).
      await this.sequelize.query(`SET LOCAL hnsw.iterative_scan = relaxed_order; SET LOCAL hnsw.ef_search = 100`, { transaction });
      return this.sequelize.query<{ src: 'vec' | 'fts'; id: string; similarity: number | null }>(
        `(SELECT 'vec' AS src, c.id, 1 - (c.embedding <=> CAST(:q AS halfvec)) AS similarity
          FROM "KnowledgeChunk" c WHERE ${sql}
          ORDER BY c.embedding <=> CAST(:q AS halfvec) LIMIT :n)
         UNION ALL
         (SELECT 'fts' AS src, c.id, NULL AS similarity
          FROM "KnowledgeChunk" c, websearch_to_tsquery('english', :question) query
          WHERE ${sql} AND c.tsv @@ query
          ORDER BY ts_rank_cd(c.tsv, query) DESC LIMIT :n)`,
        { type: QueryTypes.SELECT, transaction, replacements: { ...replacements, q: toVectorLiteral(embedding), question, n: CANDIDATES } },
      );
    });

    const similarity = new Map(rows.filter((r) => r.src === 'vec').map((r) => [r.id, Number(r.similarity)]));
    const ftsIds = rows.filter((r) => r.src === 'fts').map((r) => r.id);
    const vecIds = rows.filter((r) => r.src === 'vec' && Number(r.similarity) >= this.minSimilarity).map((r) => r.id);
    const fused = reciprocalRankFusion([vecIds, ftsIds]).slice(0, k);
    if (!fused.length) return [];

    const chunks = await this.sequelize.query<Omit<RetrievedChunk, 'similarity' | 'score'>>(
      `SELECT c.id, c."documentId", d.title, c."headingPath", c.page, c.content
       FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d.id = c."documentId"
       WHERE c.id IN (:ids) AND d.status = 'READY'`,
      { type: QueryTypes.SELECT, replacements: { ids: fused.map((f) => f.id) } },
    );
    const byId = new Map(chunks.map((c) => [c.id, c]));
    return fused.filter((f) => byId.has(f.id)).map((f) => ({ ...byId.get(f.id)!, similarity: similarity.get(f.id) ?? null, score: f.score }));
  }

  /** Repeated questions ("does it support eSIM?") skip the embedding call entirely. */
  private async queryEmbedding(question: string): Promise<number[]> {
    const normalized = question.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = `rag:qemb:${this.embedder.model}:${createHash('sha256').update(normalized).digest('hex')}`;
    const cached = await this.redis.client.getBuffer(key).catch(() => null);
    // Copy first: a pooled Buffer's byteOffset need not be 4-aligned.
    if (cached) return Array.from(new Float32Array(Uint8Array.from(cached).buffer));
    const [embedding] = await this.embedder.embed([normalized], 'query');
    await this.redis.client.set(key, Buffer.from(new Float32Array(embedding).buffer), 'EX', QUERY_EMBEDDING_TTL_S).catch(() => undefined);
    return embedding;
  }
}
