import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DependencyUnavailableError, type CodeSequence } from '../domain/ports';

export const CODE_SEQUENCE_KEY = 'share-links:id-seq';
const BLOCK_SIZE = 1_000;
const REDIS_TIMEOUT_MS = 150;

/**
 * Ticket-server style number allocation: each instance leases a block of 1,000 numbers with one Redis INCRBY and
 * hands them out locally, so instances never coordinate and the counter sees one call per 1,000 links. Numbers left
 * in a stopped instance's block are never reissued (gaps are harmless; codes stay unguessable).
 *
 * Owner: `marketing` (S37). `share-links:id-seq` has no TTL: it is a counter, not a cache. A lost counter or a
 * changed code key shows up as generated-code collisions, which the create path absorbs by retrying (AS-07).
 */
@Injectable()
export class RedisCodeSequence implements CodeSequence {
  private cursor = 0;
  private end = 0;
  private pending?: Promise<void>;

  constructor(private readonly redis: RedisService) {}

  async next(): Promise<number> {
    while (this.cursor >= this.end) {
      this.pending ??= this.lease().finally(() => (this.pending = undefined));
      await this.pending;
    }
    return this.cursor++;
  }

  private async lease(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const end = await Promise.race([
        this.redis.client.incrby(CODE_SEQUENCE_KEY, BLOCK_SIZE),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('counter timeout')),
            REDIS_TIMEOUT_MS,
          );
        }),
      ]);
      this.cursor = end - BLOCK_SIZE + 1;
      this.end = end + 1;
    } catch (error) {
      throw new DependencyUnavailableError('code-counter', error);
    } finally {
      clearTimeout(timer);
    }
  }
}
