import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import {
  AUCTION_SETTINGS,
  type AuctionViewCachePort,
  type PublicAuctionView,
} from '../domain/auction-ports';
import type { AuctionSettings } from '../domain/auction-config';

export const viewKey = (auctionId: string): string =>
  `auction:view:${auctionId}`;

/**
 * The public view through the shared cache (S52): 1 s + jitter, one load at a time per key (single-flight), deleted
 * after each commit and never stored by a writer. A store outage degrades to the loader inside `getOrLoad`; a failed
 * delete never fails the write (the entry expires within the TTL). The cache is never the source of truth (III.9).
 */
@Injectable()
export class AuctionViewCache implements AuctionViewCachePort {
  constructor(
    private readonly cache: CacheService,
    @Inject(AUCTION_SETTINGS) private readonly settings: AuctionSettings,
  ) {}

  getOrLoad(
    auctionId: string,
    loader: () => Promise<PublicAuctionView | null>,
  ): Promise<PublicAuctionView | null> {
    const ttlMs = this.settings.viewCacheMs;
    return this.cache.getOrLoad<PublicAuctionView>(viewKey(auctionId), loader, {
      ttlMs,
      swrMs: ttlMs,
      negativeTtlMs: ttlMs,
      jitter: 0.1,
      l1: 'never' as const,
    });
  }

  async invalidate(auctionId: string): Promise<void> {
    await this.cache.invalidate([viewKey(auctionId)]);
  }
}
