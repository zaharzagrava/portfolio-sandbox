import { Injectable } from '@nestjs/common';
import type { PageCache } from '../domain/ports';
import { RedisGuard } from './redis-guard';

const SORTS = ['best', 'new', 'old'] as const;
const pageKey = (key: string) => `dsc:page:${key}`;

/** The viewer-independent first page of a thread, cached for seconds (S25 D8, FR-036). Key: `<postId>:<sort>`. */
@Injectable()
export class RedisPageCache implements PageCache {
  constructor(private readonly guard: RedisGuard) {}

  get(key: string): Promise<string | null> {
    return this.guard.run((c) => c.get(pageKey(key)));
  }

  async set(key: string, json: string, ttlSeconds: number): Promise<void> {
    await this.guard.run((c) => c.set(pageKey(key), json, 'EX', ttlSeconds));
  }

  /** Every write to a thread drops its cached pages. */
  async drop(postId: string): Promise<void> {
    await this.guard.run((c) =>
      c.del(...SORTS.map((sort) => pageKey(`${postId}:${sort}`))),
    );
  }
}
