import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BidResult, MyBid } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  AuctionClosedError,
  AuctionNotFoundError,
  AuctionNotStartedError,
  BidNotIncreasingError,
  BidTooLowError,
  BidUnavailableError,
  MembershipUnavailableError,
  ShillBidForbiddenError,
} from '../domain/auction-errors';
import {
  AUCTION_REPOSITORY,
  AUCTION_SETTINGS,
  BID_REPOSITORY,
  SHOP_MEMBERSHIP,
  type AuctionRecord,
  type AuctionRepository,
  type BidRepository,
  type ShopMembershipPort,
} from '../domain/auction-ports';
import type { AuctionSettings } from '../domain/auction-config';
import { extendEnd } from '../domain/auction-schedule';
import { biddingDecision } from '../domain/auction-state';
import {
  bidDuration,
  bidsCounter,
  extensionsCounter,
  shillBlockedCounter,
  type BidMetricOutcome,
} from '../domain/auction-metrics';
import { isReserveMet, minimumNextMax, resolveBid } from '../domain/proxy-bid';
import { leaderAliasOf } from '../domain/auction-views';
import { BID_DECISION_GATE, type BidDecisionGate } from './auction-test-seams';
import { auctionSpan } from './auction-tracing';
import { AuctionPublisher } from './auction-publisher';
import { AuctionScheduleService } from './auction-schedule.service';
import {
  AuctionBidPlaced,
  AuctionLeaderChanged,
  eventBase,
} from './events/auction-events';

import './auction.job-types';

/** Postgres `lock_not_available`: the row lock was not granted within `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03';
const LOCK_TIMEOUT_MS = 2000;

const pgCode = (error: unknown): string | undefined => {
  const e = error as {
    parent?: { code?: string };
    original?: { code?: string };
  };
  return e?.parent?.code ?? e?.original?.code;
};

/**
 * Placing a bid (S21 FR-012–FR-023). One decision step per auction (research R-01): the shill lookup is made first,
 * outside any transaction; then one transaction takes the auction row lock, decides with the pure `resolveBid`, appends
 * the bid, updates the auction under its version and appends the events. Redis holds nothing that decides a bid. The
 * cache delete and the realtime push run after the commit and can fail without touching the answer.
 */
@Injectable()
export class BidService {
  private readonly logger = new Logger(BidService.name);

  constructor(
    @Inject(AUCTION_REPOSITORY) private readonly auctions: AuctionRepository,
    @Inject(BID_REPOSITORY) private readonly bids: BidRepository,
    @Inject(SHOP_MEMBERSHIP) private readonly membership: ShopMembershipPort,
    @Inject(AUCTION_SETTINGS) private readonly settings: AuctionSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(BID_DECISION_GATE) private readonly gate: BidDecisionGate,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly publisher: AuctionPublisher,
    private readonly schedule: AuctionScheduleService,
  ) {}

  placeBid(
    auctionId: string,
    bidderId: string,
    maxAmountMinor: number,
  ): Promise<BidResult> {
    return auctionSpan('auction.bid', { auctionId }, () =>
      this.place(auctionId, bidderId, maxAmountMinor),
    );
  }

  private async place(
    auctionId: string,
    bidderId: string,
    maxAmountMinor: number,
  ): Promise<BidResult> {
    const started = process.hrtime.bigint();
    try {
      const known = await this.auctions.findById(auctionId);
      if (!known) throw new AuctionNotFoundError();
      await this.assertNotShill(known, bidderId);

      const { next, outcome } = await this.decide(
        auctionId,
        bidderId,
        maxAmountMinor,
      );
      bidsCounter.add(1, { outcome });
      // ids and the outcome only: a maximum, the bidder's or anyone's, never goes to a log line
      this.logger.log({
        event: 'auction.bid',
        auctionId,
        bidderId,
        outcome,
        version: next.version,
      });
      return this.result(next, bidderId, outcome);
    } catch (error) {
      const metric = this.rejection(error);
      if (metric) {
        bidsCounter.add(1, { outcome: metric });
        this.logger.log({
          event: 'auction.bid',
          auctionId,
          bidderId,
          outcome: metric,
        });
      }
      if (pgCode(error) === LOCK_NOT_AVAILABLE) throw new BidUnavailableError();
      throw error;
    } finally {
      bidDuration.record(Number(process.hrtime.bigint() - started) / 1e9);
    }
  }

  /** The bidder's own maximum (never another user's) and whether they lead. */
  async myBid(auctionId: string, userId: string): Promise<MyBid> {
    const auction = await this.auctions.findById(auctionId);
    if (!auction) throw new AuctionNotFoundError();
    const own = await this.bids.myBid(auctionId, userId);
    return {
      maxAmountMinor: own?.maxAmountMinor ?? null,
      isLeading: auction.leaderId === userId,
      priceMinor: auction.priceMinor,
    };
  }

  // ------------------------------------------------------------------ steps

  /** Members of the selling shop never bid (FR-017); an unchecked identity never bids (fail closed). */
  private async assertNotShill(
    auction: AuctionRecord,
    bidderId: string,
  ): Promise<void> {
    let member: boolean;
    try {
      member = await this.membership.isMember(auction.shopId, bidderId);
    } catch (error) {
      if (error instanceof MembershipUnavailableError)
        throw new BidUnavailableError();
      throw error;
    }
    if (member) {
      shillBlockedCounter.add();
      throw new ShillBidForbiddenError();
    }
  }

  private async decide(
    auctionId: string,
    bidderId: string,
    maxAmountMinor: number,
  ) {
    const now = this.clock.now();
    return this.runner.run(
      async () => {
        let auction = await this.auctions.lockById(auctionId);
        if (!auction) throw new AuctionNotFoundError();
        // after the lock, before the decision: the spec holds a bid here while the close is attempted (AS-32)
        await this.gate.hold({ auctionId, bidderId });

        const window = biddingDecision(auction, now);
        if (window.kind === 'not_started')
          throw new AuctionNotStartedError(auction.startsAt);
        if (window.kind === 'closed')
          throw new AuctionClosedError(auction.status);
        if (window.opens)
          auction = await this.schedule.openLocked(
            auction,
            `bidder:${bidderId}`,
            now,
          );

        const resolved = resolveBid(
          {
            priceMinor: auction.priceMinor,
            leaderId: auction.leaderId,
            leaderMaxMinor: auction.leaderMaxMinor,
            minIncrementMinor: auction.minIncrementMinor,
            reservePriceMinor: auction.reservePriceMinor,
            startingPriceMinor: auction.startingPriceMinor,
          },
          { bidderId, maxAmountMinor },
        );
        if (!resolved.ok)
          throw resolved.rejection === 'bid_too_low'
            ? new BidTooLowError(resolved.minimumMaxAmountMinor)
            : new BidNotIncreasingError(resolved.currentMaxAmountMinor);

        const priceChanged = resolved.outcome !== 'raised';
        const end = extendEnd({
          endsAt: auction.endsAt,
          originalEndsAt: auction.originalEndsAt,
          now,
          priceChanged,
          windowMs: this.settings.snipeWindowMs,
          extensionMs: this.settings.snipeExtensionMs,
          capMs: this.settings.snipeCapMs,
        });

        const sequence = auction.bidCount + 1;
        await this.bids.append({
          auctionId,
          bidderId,
          maxAmountMinor,
          outcome: resolved.outcome,
          priceAfterMinor: resolved.priceMinor,
          sequence,
          createdAt: now,
        });
        const next = await this.auctions.applyBid(auctionId, {
          priceMinor: resolved.priceMinor,
          leaderId: resolved.leaderId,
          leaderMaxMinor: resolved.leaderMaxMinor,
          endsAt: end.endsAt,
          expectedVersion: auction.version,
          now,
        });

        await this.outbox.append(
          AuctionBidPlaced.create(
            next.id,
            next.version,
            {
              ...eventBase(next),
              bidderId,
              outcome: resolved.outcome,
              priceMinor: next.priceMinor,
              currency: next.currency,
              leaderId: resolved.leaderId,
              endsAt: next.endsAt.toISOString(),
              extended: end.extended,
              sequence,
            },
            now,
          ),
        );
        if (resolved.leaderChanged && resolved.previousLeaderId)
          await this.outbox.append(
            AuctionLeaderChanged.create(
              next.id,
              next.version,
              {
                ...eventBase(next),
                previousLeaderId: resolved.previousLeaderId,
                leaderId: resolved.leaderId,
                priceMinor: next.priceMinor,
                currency: next.currency,
              },
              now,
            ),
          );
        if (end.extended) {
          // one close job per (auction, end): the new end gets its own, the old one finds a later end and re-arms nothing
          await this.jobs.enqueue(
            'auctions.close',
            { auctionId },
            {
              runAt: end.endsAt,
              idempotencyKey: `auction-close:${auctionId}:${end.endsAt.getTime()}`,
            },
          );
          extensionsCounter.add();
        }
        this.publisher.price(next);
        return { next, outcome: resolved.outcome as BidMetricOutcome };
      },
      { lockTimeoutMs: LOCK_TIMEOUT_MS },
    );
  }

  private result(
    next: AuctionRecord,
    bidderId: string,
    outcome: BidMetricOutcome,
  ): BidResult {
    return {
      outcome: outcome as BidResult['outcome'],
      priceMinor: next.priceMinor,
      youAreLeading: next.leaderId === bidderId,
      leaderAlias: leaderAliasOf(this.settings.aliasSecret, next),
      endsAt: next.endsAt.toISOString(),
      version: next.version,
      serverTime: this.clock.now().toISOString(),
      minimumNextMaxMinor: minimumNextMax(next),
      reserveMet: isReserveMet(next.priceMinor, next.reservePriceMinor),
      hasReserve: next.reservePriceMinor !== null,
    };
  }

  private rejection(error: unknown): BidMetricOutcome | null {
    if (error instanceof BidTooLowError) return 'rejected_low';
    if (error instanceof BidNotIncreasingError)
      return 'rejected_not_increasing';
    if (
      error instanceof AuctionClosedError ||
      error instanceof AuctionNotStartedError
    )
      return 'rejected_closed';
    if (error instanceof ShillBidForbiddenError) return 'rejected_shill';
    return null;
  }
}
