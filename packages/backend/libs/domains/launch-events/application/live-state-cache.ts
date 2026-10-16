import { Inject, Injectable, Logger } from '@nestjs/common';
import { CacheService, cacheKey } from '@app/infrastructure/cache';
import { STATE_NEGATIVE_TTL_MS, STATE_TTL_MS } from '../domain/live-constants';
import {
  LIVE_STREAMS,
  type LiveStreamRecord,
  type LiveStreamRepository,
  type StoredPin,
} from '../domain/live-ports';
import type { LiveStatus } from '../domain/live-state';
import { logLiveWarn } from './live-log';

/** The stream record as the hot paths read it: plain JSON (dates as ISO strings), safe to keep in the cache. */
export interface LiveStreamState {
  id: string;
  shopId: string;
  title: string;
  status: LiveStatus;
  launchEventId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  pin: StoredPin | null;
  pinVersion: number;
}

export const toState = (record: LiveStreamRecord): LiveStreamState => ({
  id: record.id,
  shopId: record.shopId,
  title: record.title,
  status: record.status,
  launchEventId: record.launchEventId,
  startedAt: record.startedAt?.toISOString() ?? null,
  endedAt: record.endedAt?.toISOString() ?? null,
  createdAt: record.createdAt.toISOString(),
  pin: record.pin,
  pinVersion: record.pinVersion,
});

const stateKey = (streamId: string) => cacheKey('live', 1, 'stream', streamId);

/**
 * Per-stream state from the authoritative record, cache-aside through the S52 toolkit (FR-026): a warm stream costs no
 * relational query, a cold one is refilled by ONE shared read however many requests arrive at once, and an unknown id is
 * negatively cached for 10 seconds so random ids cannot reach the database. Writers delete the entry (`evict`) before
 * they publish what changed.
 */
@Injectable()
export class LiveStateCache {
  private readonly logger = new Logger(LiveStateCache.name);

  constructor(
    private readonly cache: CacheService,
    @Inject(LIVE_STREAMS) private readonly streams: LiveStreamRepository,
  ) {}

  get(streamId: string): Promise<LiveStreamState | null> {
    return this.cache.getOrLoad<LiveStreamState>(
      stateKey(streamId),
      async () => {
        const record = await this.streams.findById(streamId);
        return record ? toState(record) : null;
      },
      {
        ttlMs: STATE_TTL_MS,
        negativeTtlMs: STATE_NEGATIVE_TTL_MS,
        l1: 'never',
      },
    );
  }

  async evict(streamId: string): Promise<void> {
    const result = await this.cache.invalidate([stateKey(streamId)]);
    if (result.l2 === 'failed')
      logLiveWarn(this.logger, 'state_cache_not_dropped', { streamId });
  }
}
