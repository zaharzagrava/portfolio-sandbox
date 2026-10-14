import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  ragRetrievalDeadline,
  ragRetrievalDegraded,
  ragRetrievalDuration,
} from '../domain/knowledge-metrics';
import { RetrievalUnavailableError } from '../domain/knowledge-errors';
import {
  EMBEDDING_PROVIDER,
  PASSAGE_REPOSITORY,
  QUESTION_CACHE,
} from '../domain/ports';
import type {
  Candidates,
  EmbeddingProvider,
  PassageRepository,
  QuestionCache,
} from '../domain/ports';
import { reciprocalRankFusion } from '../domain/rrf';
import type { RetrievalScope } from '../domain/scope';

export interface RetrievedChunk {
  id: string;
  documentId: string;
  title: string;
  headingPath: string;
  page: number | null;
  content: string;
  /** Cosine similarity when the meaning search found it, else null (keyword-only hit). */
  similarity: number | null;
  score: number;
}

export interface SearchResult {
  mode: 'hybrid' | 'keyword';
  items: RetrievedChunk[];
}

const QUERY_EMBEDDING_TTL_S = 86_400;
const MAX_K = 20;

/** Trim, collapse whitespace, lowercase: the identity of a question for the embedding cache (S47 FR-025). */
export const normalizeQuestion = (question: string) =>
  question.trim().replace(/\s+/g, ' ').toLowerCase();

/** `rag:qe:v1:<sha256(model + normalized question)>`; the model is part of the key, so a model change never reuses a vector. */
export const questionCacheKey = (model: string, normalized: string) =>
  `rag:qe:v1:${createHash('sha256').update(`${model}\n${normalized}`).digest('hex')}`;

/** First 12 hex characters of the question hash: the only form of a question that logs and traces may carry (AS-53). */
export const questionHashPrefix = (model: string, question: string) =>
  createHash('sha256')
    .update(`${model}\n${normalizeQuestion(question)}`)
    .digest('hex')
    .slice(0, 12);

/**
 * Hybrid retrieval (S47 FR-020 – FR-026; patterns P0308, P1114): a meaning search (HNSW over halfvec) and a keyword
 * search (full-text with headings weighted above body) run in ONE statement, both filtered by the caller's scope inside
 * the query, then fused by reciprocal rank fusion. Meaning hits below the relevance floor count only when the keyword
 * search also found them, so an off-topic question yields nothing. If the question cannot be embedded in time the search
 * degrades to keywords only (`mode: 'keyword'`); the provider is never retried in the same request.
 */
@Injectable()
export class KnowledgeSearchService {
  constructor(
    @Inject(PASSAGE_REPOSITORY) private readonly passages: PassageRepository,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
    @Inject(QUESTION_CACHE) private readonly cache: QuestionCache,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  /** The only form of a question that logs and traces carry: the prefix of the hash the embedding cache keys on (AS-53). */
  questionHash(question: string): string {
    return questionHashPrefix(this.embedder.model, question);
  }

  /** Throws `RetrievalUnavailableError` when the statement deadline passes. */
  async search(
    scope: RetrievalScope,
    question: string,
    options: { k?: number } = {},
  ): Promise<SearchResult> {
    const started = this.clock.nowMs();
    const k = Math.min(
      Math.max(1, Math.floor(options.k ?? this.config.get('rag_top_k'))),
      MAX_K,
    );
    const normalized = normalizeQuestion(question);
    const vector = await this.questionVector(normalized);
    const mode = vector ? 'hybrid' : 'keyword';

    const floor = this.config.get('rag_min_similarity');
    // Meaning hits below the floor count only when the keyword search also found them (they are in `fts` then).
    const fuse = (c: Candidates) =>
      reciprocalRankFusion([
        c.vec.filter((v) => v.similarity >= floor).map((v) => v.id),
        c.fts.map((f) => f.id),
      ]).slice(0, k);

    let retrieved: Awaited<ReturnType<PassageRepository['retrieve']>>;
    let fused: { id: string; score: number }[] = [];
    try {
      retrieved = await this.passages.retrieve(
        {
          scope,
          queryText: normalized,
          vector,
          model: this.embedder.model,
          limit: this.config.get('rag_candidates'),
          timeoutMs: this.config.get('rag_retrieval_timeout_ms'),
        },
        (candidates) => {
          fused = fuse(candidates);
          return fused.map((f) => f.id);
        },
      );
    } catch (error) {
      if (error instanceof RetrievalUnavailableError)
        ragRetrievalDeadline.add(1);
      throw error;
    }

    const similarity = new Map(
      retrieved.candidates.vec.map((v) => [v.id, v.similarity]),
    );
    const byId = new Map(retrieved.passages.map((p) => [p.id, p]));
    const items = fused
      .filter((f) => byId.has(f.id))
      .map((f) => ({
        ...byId.get(f.id)!,
        similarity: similarity.get(f.id) ?? null,
        score: f.score,
      }));
    ragRetrievalDuration.record((this.clock.nowMs() - started) / 1000, {
      mode,
    });
    return { mode, items };
  }

  /** The question's embedding from the cache or the provider, or `null` when it cannot be had in time (keyword-only). */
  private async questionVector(normalized: string): Promise<number[] | null> {
    const key = questionCacheKey(this.embedder.model, normalized);
    try {
      const cached = await this.cache.get(key);
      if (cached) return cached;
    } catch {
      // The cache is optional and never the source of truth.
    }
    const controller = new AbortController();
    const timeoutMs = this.config.get('rag_query_embed_timeout_ms');
    let timer: NodeJS.Timeout | undefined;
    try {
      const [vector] = await Promise.race([
        this.embedder.embed([normalized], {
          kind: 'query',
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('embed_timeout'));
          }, timeoutMs);
        }),
      ]);
      void this.cache
        .set(key, vector, QUERY_EMBEDDING_TTL_S)
        .catch(() => undefined);
      return vector;
    } catch (error) {
      ragRetrievalDegraded.add(1, {
        reason:
          (error as Error).message === 'embed_timeout'
            ? 'embed_timeout'
            : 'embed_failed',
      });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
