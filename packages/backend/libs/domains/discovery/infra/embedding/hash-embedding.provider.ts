import { Injectable } from '@nestjs/common';
import { EMBEDDING_DIMS, EMBEDDING_MODEL_VERSION } from '../../domain/index-definition';
import type { EmbeddingProvider } from '../../domain/ports';

/**
 * Deterministic local embedder: every word is hashed into a few dimensions of a 64-float vector, then the vector is
 * L2-normalised, so texts that share words are close. No model, no network; the real provider replaces it behind the
 * `EmbeddingProvider` token (S32 R-08).
 */
@Injectable()
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = EMBEDDING_MODEL_VERSION;

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    const vector = new Array<number>(EMBEDDING_DIMS).fill(0);
    for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < word.length; i++) {
        h ^= word.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      for (let k = 0; k < 3; k++) {
        const slot = (h >>> (k * 8)) % EMBEDDING_DIMS;
        vector[slot] += (h >>> (k * 8 + 4)) & 1 ? 1 : -1;
      }
    }
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return norm === 0 ? vector : vector.map((v) => v / norm);
  }
}
