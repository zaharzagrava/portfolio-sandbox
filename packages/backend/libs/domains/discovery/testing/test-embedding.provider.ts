import { EMBEDDING_DIMS, EMBEDDING_MODEL_VERSION } from '../domain/index-definition';
import type { EmbeddingProvider } from '../domain/ports';

/**
 * The embedding provider of the specs (a system-edge fake, VII.2): phrases of one concept land on the same direction,
 * everything else gets a small deterministic hash vector. A spec can make it fail, hold it behind a gate (to time out
 * the budget), and count the calls.
 */
export class TestEmbeddingProvider implements EmbeddingProvider {
  modelVersion = EMBEDDING_MODEL_VERSION;
  calls: string[] = [];
  failing = false;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  private readonly concepts: { phrases: string[]; slot: number }[] = [];

  /** Texts that contain any of these phrases share a direction. */
  concept(...phrases: string[]): void {
    this.concepts.push({
      phrases: phrases.map((p) => p.toLowerCase()),
      slot: this.concepts.length,
    });
  }

  /** From now on every embed waits for `release()`. */
  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = null;
    this.open = null;
  }

  reset(): void {
    this.release();
    this.calls = [];
    this.failing = false;
    this.concepts.length = 0;
    this.modelVersion = EMBEDDING_MODEL_VERSION;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    this.calls.push(text);
    if (this.gate) {
      await Promise.race([
        this.gate,
        new Promise<never>((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
      ]);
    }
    signal?.throwIfAborted();
    if (this.failing) throw new Error('embedding provider is down');
    const lower = text.toLowerCase();
    const v = new Array<number>(EMBEDDING_DIMS).fill(0);
    let any = false;
    for (const c of this.concepts)
      if (c.phrases.some((p) => lower.includes(p))) {
        v[c.slot] += 1;
        any = true;
      }
    if (!any) {
      // a spread hash vector for unrelated text: nearly orthogonal to every concept direction
      let h = 2166136261;
      for (let i = 0; i < lower.length; i++) {
        h ^= lower.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      v[EMBEDDING_DIMS - 1 - (h % (EMBEDDING_DIMS - 8))] = 1;
    }
    return v;
  }
}
