import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ragCacheErrors } from '../domain/knowledge-metrics';
import type { QuestionCache } from '../domain/ports';

/**
 * Optional cache of question embeddings (S47 FR-025). It is never the source of truth: every failure is swallowed and
 * counted, and a miss simply embeds the question again.
 */
@Injectable()
export class QuestionCacheAdapter implements QuestionCache {
  constructor(private readonly redis: RedisService) {}

  async get(key: string): Promise<number[] | null> {
    try {
      const cached = await this.redis.client.getBuffer(key);
      if (!cached) return null;
      // Copy first: a pooled Buffer's byteOffset need not be 4-aligned.
      return Array.from(new Float32Array(Uint8Array.from(cached).buffer));
    } catch {
      ragCacheErrors.add(1, { op: 'get' });
      return null;
    }
  }

  async set(key: string, vector: number[], ttlSeconds: number): Promise<void> {
    try {
      await this.redis.client.set(
        key,
        Buffer.from(new Float32Array(vector).buffer),
        'EX',
        ttlSeconds,
      );
    } catch {
      ragCacheErrors.add(1, { op: 'set' });
    }
  }
}
