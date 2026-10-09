import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const EMBEDDING_DIMS = 1024;

/**
 * Embedding provider port (D9). `kind` matters for asymmetric models: queries
 * and documents are embedded differently (Voyage `input_type`).
 */
export abstract class Embedder {
  abstract readonly model: string;
  abstract embed(
    texts: string[],
    kind: 'document' | 'query',
  ): Promise<number[][]>;
}

const BATCH = 128;
const TIMEOUT_MS = 20_000;

/** Voyage AI (Anthropic's recommended embeddings provider), 1024-dim output to match `halfvec(1024)`. */
export class VoyageEmbedder extends Embedder {
  private readonly logger = new Logger(VoyageEmbedder.name);

  constructor(
    private readonly apiKey: string,
    readonly model = 'voyage-3.5',
  ) {
    super();
  }

  async embed(
    texts: string[],
    kind: 'document' | 'query',
  ): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH)
      out.push(...(await this.batch(texts.slice(i, i + BATCH), kind)));
    return out;
  }

  /** Retries 429/5xx with exponential backoff + full jitter (embedding a batch is idempotent). */
  private async batch(
    input: string[],
    kind: 'document' | 'query',
    attempt = 0,
  ): Promise<number[][]> {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const delay = Math.random() * Math.min(10_000, 500 * 2 ** attempt);
      this.logger.warn(
        `voyage ${res.status}, retry in ${Math.round(delay)} ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
      return this.batch(input, kind, attempt + 1);
    }
    if (!res.ok) throw new Error(`embedding request failed: ${res.status}`);
    const body = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/**
 * Deterministic feature-hashing embedder for e2e specs and keyless dev:
 * words (lowercased, light plural stripping) and word bigrams hashed into
 * 1024 signed buckets, L2-normalised. Cosine similarity ≈ lexical overlap -
 * enough for "the chunk about eSIM is closer to the eSIM question" without a
 * model or network.
 */
export class HashingEmbedder extends Embedder {
  readonly model = 'hashing-1024';

  async embed(texts: string[]): Promise<number[][]> {
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
