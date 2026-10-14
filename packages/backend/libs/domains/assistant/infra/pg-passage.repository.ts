import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Transaction } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import { RetrievalUnavailableError } from '../domain/knowledge-errors';
import type {
  CandidateQuery,
  Candidates,
  DocumentRecord,
  NewPassage,
  PassageRepository,
  PassageText,
} from '../domain/ports';
import { describeScope, RetrievalScope } from '../domain/scope';
import { toVectorLiteral } from './embedder';

const INSERT_BATCH = 200;
/** Postgres: `query_canceled` (statement_timeout) and `lock_not_available` (lock_timeout). */
const DEADLINE_CODES = new Set(['57014', '55P03']);

/**
 * The permission filter, as SQL, built from the pure description in `domain/scope.ts`. It is spliced into BOTH candidate
 * queries and into the hydration query, so a passage outside the caller's scope is never a candidate - not filtered
 * out afterwards (a post-filter leaks through counts, timing and bugs, and starves top-k).
 */
function scopeSql(scope: RetrievalScope): {
  sql: string;
  replacements: Record<string, unknown>;
} {
  const d = describeScope(scope);
  const visibilities = d.visibilities.map((v) => `'${v}'`).join(', ');
  const own = `c."shopId" = :scopeShopId AND c.visibility IN (${visibilities})${
    d.productId
      ? ` AND (c."productId" = :scopeProductId OR c."productId" IS NULL)`
      : ''
  }`;
  return {
    sql: d.includePlatform
      ? `(c.visibility = 'PLATFORM' OR (${own}))`
      : `(${own})`,
    replacements: {
      scopeShopId: d.shopId,
      ...(d.productId ? { scopeProductId: d.productId } : {}),
    },
  };
}

/** A document serves passages while it is not deleted and holds some (R-4: a re-index keeps the old ones serving). */
const SERVING = `d.status <> 'DELETED' AND d."chunkCount" > 0`;

/** Raw SQL over `KnowledgeChunk` joined to its own document (both tables belong to `assistant`; the join is intra-owner). */
@Injectable()
export class PgPassageRepository implements PassageRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly tx: TransactionRunner,
  ) {}

  async retrieve(
    query: CandidateQuery,
    choose: (candidates: Candidates) => string[],
  ): Promise<{ candidates: Candidates; passages: PassageText[] }> {
    try {
      // One repeatable-read snapshot for ranking and text loading; the deadline covers every statement of it.
      return await this.tx.run(
        async () => {
          const candidates = await this.rank(query);
          const passages = await this.load(query.scope, choose(candidates));
          return { candidates, passages };
        },
        {
          isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
          statementTimeoutMs: query.timeoutMs,
          lockTimeoutMs: query.timeoutMs,
        },
      );
    } catch (error) {
      const code =
        (error as { parent?: { code?: string }; original?: { code?: string } })
          ?.parent?.code ??
        (error as { original?: { code?: string } })?.original?.code;
      if (code && DEADLINE_CODES.has(code))
        throw new RetrievalUnavailableError();
      throw error;
    }
  }

  private async rank(query: CandidateQuery): Promise<Candidates> {
    const { sql, replacements } = scopeSql(query.scope);
    const vec = query.vector
      ? `(SELECT 'vec' AS src, c.id, 1 - (c.embedding <=> CAST(:q AS halfvec)) AS similarity
            FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d.id = c."documentId"
           WHERE ${sql} AND ${SERVING} AND c."embeddingModel" = :model
           ORDER BY c.embedding <=> CAST(:q AS halfvec) LIMIT :n)
         UNION ALL`
      : '';
    const statement = `${vec}
         (SELECT 'fts' AS src, c.id, NULL AS similarity
            FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d.id = c."documentId",
                 websearch_to_tsquery('english', :question) query
           WHERE ${sql} AND ${SERVING} AND c.tsv @@ query
           ORDER BY ts_rank_cd(c.tsv, query) DESC LIMIT :n)`;
    // pgvector ≥ 0.8: keep walking the HNSW graph until enough rows pass the scope filter (a selective filter would
    // otherwise return fewer than the candidates asked for).
    await this.sequelize.query(
      `SET LOCAL hnsw.iterative_scan = relaxed_order; SET LOCAL hnsw.ef_search = 100`,
    );
    const rows = await this.sequelize.query<{
      src: 'vec' | 'fts';
      id: string;
      similarity: number | null;
    }>(statement, {
      type: QueryTypes.SELECT,
      replacements: {
        ...replacements,
        q: query.vector ? toVectorLiteral(query.vector) : null,
        model: query.model,
        question: query.queryText,
        n: query.limit,
      },
    });
    return {
      vec: rows
        .filter((r) => r.src === 'vec')
        .map((r) => ({ id: r.id, similarity: Number(r.similarity) })),
      fts: rows.filter((r) => r.src === 'fts').map((r) => ({ id: r.id })),
    };
  }

  /** The text of the chosen ids, with the scope predicate repeated (defense in depth, S47 FR-021). */
  private async load(
    scope: RetrievalScope,
    ids: string[],
  ): Promise<PassageText[]> {
    if (!ids.length) return [];
    const { sql, replacements } = scopeSql(scope);
    return this.sequelize.query<PassageText>(
      `SELECT c.id, c."documentId", d.title, c."headingPath", c.page, c.content
         FROM "KnowledgeChunk" c JOIN "KnowledgeDocument" d ON d.id = c."documentId"
        WHERE c.id IN (:ids) AND ${sql} AND ${SERVING}`,
      { type: QueryTypes.SELECT, replacements: { ...replacements, ids } },
    );
  }

  async replace(
    document: Pick<
      DocumentRecord,
      'id' | 'shopId' | 'productId' | 'visibility'
    >,
    embeddingModel: string,
    passages: NewPassage[],
  ): Promise<void> {
    await this.sequelize.query(
      `DELETE FROM "KnowledgeChunk" WHERE "documentId" = :id`,
      { replacements: { id: document.id } },
    );
    for (let i = 0; i < passages.length; i += INSERT_BATCH) {
      const batch = passages.slice(i, i + INSERT_BATCH);
      const replacements: Record<string, unknown> = {
        documentId: document.id,
        shopId: document.shopId,
        productId: document.productId,
        visibility: document.visibility,
        model: embeddingModel,
      };
      const values = batch.map((p, j) => {
        Object.assign(replacements, {
          [`o${j}`]: p.ordinal,
          [`h${j}`]: p.headingPath,
          [`p${j}`]: p.page,
          [`c${j}`]: p.content,
          [`t${j}`]: p.tokens,
          [`e${j}`]: toVectorLiteral(p.embedding),
        });
        return `(:documentId, :shopId, :productId, :visibility, :model, :o${j}, :h${j}, :p${j}, :c${j}, :t${j}, CAST(:e${j} AS halfvec))`;
      });
      await this.sequelize.query(
        `INSERT INTO "KnowledgeChunk" ("documentId", "shopId", "productId", visibility, "embeddingModel", ordinal, "headingPath", page, content, tokens, embedding)
         VALUES ${values.join(', ')}`,
        { replacements },
      );
    }
  }
}
