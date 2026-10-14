import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  EmbeddingProvider,
  EmbeddingUnavailableError,
  EmbedOptions,
} from '../domain/ports';

export const EMBEDDING_DIMS = 1024;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Voyage AI (Anthropic's recommended embeddings provider), 1024-dim output to match `halfvec(1024)`. No retry here:
 * ingestion retries by queue redelivery and the question path degrades to keywords (S47 FR-006, IV.6). Every failure is
 * an `EmbeddingUnavailableError` whose message carries no provider text.
 */
export class VoyageEmbedder implements EmbeddingProvider {
  readonly dimensions = EMBEDDING_DIMS;
  readonly testOnly = false;
  private readonly logger = new Logger(VoyageEmbedder.name);

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly batchSize: number,
  ) {}

  async embed(texts: string[], options: EmbedOptions): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize)
      out.push(
        ...(await this.batch(texts.slice(i, i + this.batchSize), options)),
      );
    return out;
  }

  private async batch(
    input: string[],
    { kind, signal }: EmbedOptions,
  ): Promise<number[][]> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input,
          model: this.model,
          input_type: kind,
          output_dimension: EMBEDDING_DIMS,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new EmbeddingUnavailableError('embedding request did not complete');
    }
    if (!res.ok) {
      this.logger.warn(`voyage answered ${res.status}`);
      throw new EmbeddingUnavailableError(
        `embedding request failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    const vectors = body.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    if (
      vectors.length !== input.length ||
      vectors.some((v) => v.length !== EMBEDDING_DIMS)
    )
      throw new EmbeddingUnavailableError(
        'embedding response has the wrong shape',
      );
    return vectors;
  }
}

/**
 * TEST ONLY - refused in production (`KnowledgeConfigGuard`). Deterministic feature-hashing embedder for e2e specs and
 * keyless development: words (lowercased, light plural stripping) and word bigrams hashed into 1024 signed buckets,
 * L2-normalised. Cosine similarity ≈ lexical overlap - enough for "the chunk about eSIM is closer to the eSIM question"
 * without a model or network.
 */
export class HashingEmbedder implements EmbeddingProvider {
  readonly model = 'hashing-1024';
  readonly dimensions = EMBEDDING_DIMS;
  readonly testOnly = true;

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(this.hash(texts));
  }

  private hash(texts: string[]): number[][] {
    return texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIMS).fill(0);
      const words = t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const terms = words.map((w) =>
        w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w,
      );
      const features = [
        ...terms,
        ...terms.slice(1).map((w, i) => `${terms[i]}_${w}`),
      ];
      for (const f of features) {
        const h = createHash('md5').update(f).digest();
        v[h.readUInt16BE(0) % EMBEDDING_DIMS] += h[2] & 1 ? 1 : -1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** pgvector literal. */
export const toVectorLiteral = (v: number[]) =>
  `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',')}]`;
