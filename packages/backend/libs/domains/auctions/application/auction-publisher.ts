import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { afterCommit } from '@app/infrastructure/context';
import {
  AUCTION_REALTIME,
  AUCTION_SETTINGS,
  AUCTION_VIEW_CACHE,
  type AuctionRealtimePort,
  type AuctionRecord,
  type AuctionViewCachePort,
} from '../domain/auction-ports';
import type { AuctionSettings } from '../domain/auction-config';
import { isReserveMet } from '../domain/proxy-bid';
import { leaderAliasOf } from '../domain/auction-views';

/**
 * What happens after an auction's change commits (S21 FR-033, FR-035): the cached public view is dropped and the new
 * price or the close is pushed. Both run in `afterCommit`, never inside the transaction, and neither can fail the
 * write: the cache delete and the push swallow their own errors (counted and logged by the adapters).
 */
@Injectable()
export class AuctionPublisher {
  constructor(
    @Inject(AUCTION_VIEW_CACHE) private readonly cache: AuctionViewCachePort,
    @Inject(AUCTION_REALTIME) private readonly realtime: AuctionRealtimePort,
    @Inject(AUCTION_SETTINGS) private readonly settings: AuctionSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The view changed: drop the cached copy once the transaction commits. */
  changed(auction: Pick<AuctionRecord, 'id'>): void {
    afterCommit(() => this.cache.invalidate(auction.id));
  }

  /** A bid changed the price, the leader or the end. */
  price(auction: AuctionRecord): void {
    this.changed(auction);
    afterCommit(() =>
      this.realtime.publishPrice({
        auctionId: auction.id,
        priceMinor: auction.priceMinor,
        leaderAlias: leaderAliasOf(this.settings.aliasSecret, auction),
        endsAt: auction.endsAt.toISOString(),
        reserveMet: isReserveMet(auction.priceMinor, auction.reservePriceMinor),
        version: auction.version,
        serverTime: this.clock.now().toISOString(),
      }),
    );
  }

  /** The auction closed (`CLOSED` or `UNSOLD`): no winner identity in the message. */
  closed(auction: AuctionRecord): void {
    this.changed(auction);
    if (auction.status !== 'CLOSED' && auction.status !== 'UNSOLD') return;
    afterCommit(() =>
      this.realtime.publishClosed({
        auctionId: auction.id,
        status: auction.status as 'CLOSED' | 'UNSOLD',
        finalPriceMinor: auction.finalPriceMinor,
        version: auction.version,
      }),
    );
  }
}
