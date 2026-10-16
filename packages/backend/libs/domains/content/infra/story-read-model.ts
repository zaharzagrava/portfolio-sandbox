import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { CacheService } from '@app/infrastructure/cache';
import type { PublishedSnapshot, ReadModel } from '../domain/ports';
import { STORY_CONFIG } from '../application/story-config.token';
import type { StoryConfig } from '../domain/limits';
import { storyMetrics } from '../application/story-metrics';

/** `story:pub:<shopSlug>:<slug>` (S27 data-model): the published version with every locale. */
export const readModelKey = (shopSlug: string, slug: string): string =>
  `story:pub:${shopSlug}:${slug}`;

const degradedCount = (): number =>
  MetricsRegistry.value('cache_requests_total', {
    namespace: 'story',
    outcome: 'degraded',
  }) ?? 0;

/**
 * The origin read model on the cache toolkit (S52): single flight per key, a short TTL without jitter (an entry
 * never outlives 60 s, FR-025), no per-process copy (a delete must reach every replica at once), and a store that
 * is empty or down never fails a read: the toolkit calls the durable loader instead. Writers only delete.
 */
@Injectable()
export class CachedStoryReadModel implements ReadModel {
  private readonly logger = new Logger('StoryReadModel');
  private lastAlertMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly cache: CacheService,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getOrLoad(
    shopSlug: string,
    slug: string,
    load: () => Promise<PublishedSnapshot | null>,
  ): Promise<PublishedSnapshot | null> {
    const degradedBefore = degradedCount();
    let loaded = false;
    const value = await this.cache.getOrLoad<PublishedSnapshot>(
      readModelKey(shopSlug, slug),
      () => {
        loaded = true;
        return load();
      },
      {
        ttlMs: this.config.readModelTtlSeconds * 1_000,
        jitter: 0,
        l1: 'never',
        timeoutMs: this.config.dependencyTimeoutMs,
      },
    );
    const source = !loaded
      ? 'cache'
      : degradedCount() > degradedBefore
        ? 'fallback'
        : 'durable';
    storyMetrics.readOrigin.add(1, { source });
    if (source === 'fallback') this.alertFallback();
    return value;
  }

  /** The cache is down and reads go to the durable store: alert-worthy, at most one line per 10 seconds. */
  private alertFallback(): void {
    const now = this.clock.nowMs();
    if (now - this.lastAlertMs < 10_000) return;
    this.lastAlertMs = now;
    this.logger.warn(
      'alert: the origin cache is unreachable; stories are read from the durable store',
    );
  }

  async del(shopSlug: string, slug: string): Promise<void> {
    await this.cache.invalidate([readModelKey(shopSlug, slug)]);
  }
}
