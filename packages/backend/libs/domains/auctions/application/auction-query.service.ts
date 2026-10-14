import { Inject, Injectable } from '@nestjs/common';
import type {
  AuctionPublic,
  BidHistoryPage,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { AuctionNotFoundError } from '../domain/auction-errors';
import {
  AUCTION_REPOSITORY,
  AUCTION_SETTINGS,
  AUCTION_VIEW_CACHE,
  BID_REPOSITORY,
  type AuctionRepository,
  type AuctionViewCachePort,
  type BidRepository,
} from '../domain/auction-ports';
import type { AuctionSettings } from '../domain/auction-config';
import { bidderAlias } from '../domain/bidder-alias';
import { toPublicView } from '../domain/auction-views';

/** Auctions closed within this long still appear in the batch read (a page keeps showing the result for a day). */
const RECENT_MS = 24 * 3_600_000;

/**
 * Public reads (S21 FR-033, FR-034): the live view, the batch for the BFF and the bid history. All three read the
 * durable record; the view goes through the shared cache (1 s, one load at a time per auction) and falls back to the
 * durable record when the cache is down. The cache is never the source of truth and never holds a bid's decision.
 * Only public fields leave: no user ID, no maximum, no reserve amount; bidders are per-auction aliases.
 */
@Injectable()
export class AuctionQueryService {
  constructor(
    @Inject(AUCTION_REPOSITORY) private readonly auctions: AuctionRepository,
    @Inject(BID_REPOSITORY) private readonly bids: BidRepository,
    @Inject(AUCTION_VIEW_CACHE) private readonly cache: AuctionViewCachePort,
    @Inject(AUCTION_SETTINGS) private readonly settings: AuctionSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(auctionId: string): Promise<AuctionPublic> {
    const view = await this.cache.getOrLoad(auctionId, async () => {
      const auction = await this.auctions.findById(auctionId);
      return auction
        ? toPublicView(auction, this.settings.aliasSecret, this.clock.now())
        : null;
    });
    if (!view) throw new AuctionNotFoundError();
    // the countdown anchors on the server's clock now, not on when the entry was cached
    return { ...view, serverTime: this.clock.now().toISOString() };
  }

  /** One statement for up to 100 products; unknown products are simply absent. */
  async byProducts(productIds: string[]): Promise<AuctionPublic[]> {
    const now = this.clock.now();
    const found = await this.auctions.listPublicByProducts(
      productIds,
      now,
      RECENT_MS,
    );
    return found.map((a) => toPublicView(a, this.settings.aliasSecret, now));
  }

  /** Price-changing bids, newest first, as aliases (FR-009, FR-034). */
  async history(
    auctionId: string,
    query: { limit: number; cursor?: string },
  ): Promise<BidHistoryPage> {
    const auction = await this.auctions.findById(auctionId);
    if (!auction) throw new AuctionNotFoundError();
    const page = await this.bids.historyPage(auctionId, query);
    return {
      items: page.items.map((bid) => ({
        sequence: bid.sequence,
        priceMinor: bid.priceAfterMinor,
        outcome: bid.outcome as 'leading' | 'outbid',
        bidderAlias: bidderAlias(
          this.settings.aliasSecret,
          auctionId,
          bid.bidderId,
        ),
        placedAt: bid.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
