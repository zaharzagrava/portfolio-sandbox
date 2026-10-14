import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  AUCTION_REPOSITORY,
  SHOP_MEMBERSHIP,
  type AuctionRecord,
  type AuctionRepository,
  type ShopMembershipPort,
} from '../domain/auction-ports';
import {
  closedCounter,
  closeLag,
  openOverdue,
} from '../domain/auction-metrics';
import { transition, type UnsoldAtClose } from '../domain/auction-state';
import { isReserveMet } from '../domain/proxy-bid';
import { auctionSpan } from './auction-tracing';
import { AuctionPublisher } from './auction-publisher';
import { AuctionScheduleService } from './auction-schedule.service';
import { AuctionClosed, eventBase } from './events/auction-events';

import './auction.job-types';

/** The leader is checked outside the transaction; a bid that changes the leader in between sends us round again. */
const MAX_RECHECKS = 3;
const SWEEP_BATCH = 200;
/** An `OPEN` auction this long past its end pages someone (AuctionCloseOverdue). */
const OVERDUE_AFTER_MS = 60_000;

export type CloseOutcome =
  'unknown' | 'noop' | 'early' | 'closed' | 'unsold' | 'deferred';

type Decision =
  | { kind: 'noop' }
  | { kind: 'early' }
  | { kind: 'stale' }
  | { kind: 'closed'; auction: AuctionRecord }
  | { kind: 'unsold'; auction: AuctionRecord };

/**
 * Exactly-once close (S21 FR-025–FR-027). One conditional transition `OPEN → CLOSED | UNSOLD`, taken only when the
 * stored end has passed, serialized with bids by the row lock, with its history row, `auction.closed` event and the
 * follow-up jobs (the winner's order request, or the stock return) in the same transaction. The leader's membership
 * (the shill re-check, FR-026) is read before the transaction opens, never inside it; if a bid changed the leader
 * between that check and the lock the decision is made again, and an unchecked leader is never awarded.
 */
@Injectable()
export class AuctionCloseService {
  private readonly logger = new Logger(AuctionCloseService.name);

  constructor(
    @Inject(AUCTION_REPOSITORY) private readonly auctions: AuctionRepository,
    @Inject(SHOP_MEMBERSHIP) private readonly membership: ShopMembershipPort,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly publisher: AuctionPublisher,
    private readonly schedule: AuctionScheduleService,
  ) {}

  /** `auctions.close` and the sweeper: safe to run any number of times, concurrently, or early. */
  closeIfDue(auctionId: string): Promise<CloseOutcome> {
    return auctionSpan('auction.close', { auctionId }, async () => {
      const outcome = await this.close(auctionId);
      this.logger.log({ event: 'auction.close', auctionId, outcome });
      return outcome;
    });
  }

  private async close(auctionId: string): Promise<CloseOutcome> {
    for (let attempt = 0; attempt < MAX_RECHECKS; attempt++) {
      const known = await this.auctions.findById(auctionId);
      if (!known) return 'unknown';
      if (known.status !== 'OPEN' && known.status !== 'SCHEDULED')
        return 'noop';

      const now = this.clock.now();
      // outside any transaction: the membership lookup is a call to another capability
      const checkedLeader = known.leaderId;
      const leaderIsMember =
        checkedLeader !== null && now.getTime() >= known.endsAt.getTime()
          ? await this.membership.isMember(known.shopId, checkedLeader)
          : false;

      const decision = await this.decide(
        auctionId,
        checkedLeader,
        leaderIsMember,
        now,
      );
      switch (decision.kind) {
        case 'noop':
        case 'early':
          return decision.kind;
        case 'stale':
          continue;
        case 'closed':
        case 'unsold':
          return decision.kind;
      }
    }
    // the leader keeps changing under us: leave it OPEN, the next sweep decides again
    this.logger.warn(
      `close of auction ${auctionId} deferred: the leader kept changing`,
    );
    return 'deferred';
  }

  private decide(
    auctionId: string,
    checkedLeader: string | null,
    leaderIsMember: boolean,
    now: Date,
  ): Promise<Decision> {
    return this.runner.run(async (): Promise<Decision> => {
      let auction = await this.auctions.lockById(auctionId);
      if (!auction) return { kind: 'noop' };
      if (auction.status === 'SCHEDULED') {
        // never opened (its open job and bids never came) but held and past its end: open and close it empty
        if (!auction.unitHeld || now.getTime() < auction.endsAt.getTime())
          return { kind: 'noop' };
        auction = await this.schedule.openLocked(auction, 'system:close', now);
      }
      if (auction.status !== 'OPEN') return { kind: 'noop' };
      if (now.getTime() < auction.endsAt.getTime()) {
        // the end moved (anti-sniping) after this job was set: the new end has its own job; make sure it exists
        await this.armClose(auction);
        return { kind: 'early' };
      }
      if (auction.leaderId !== checkedLeader) return { kind: 'stale' };

      const reserveMet = isReserveMet(
        auction.priceMinor,
        auction.reservePriceMinor,
      );
      // no reserve means nothing to meet; `reserveMet` itself is always false then (FR-014)
      const reserveOk = auction.reservePriceMinor === null || reserveMet;
      const unsoldReason: UnsoldAtClose | null =
        auction.leaderId === null
          ? 'no_bids'
          : leaderIsMember
            ? 'leader_ineligible'
            : !reserveOk
              ? 'reserve_not_met'
              : null;

      const move = transition(
        'OPEN',
        unsoldReason
          ? { type: 'close', outcome: { kind: 'unsold', reason: unsoldReason } }
          : { type: 'close', outcome: { kind: 'winner' } },
      );
      if (!move.ok) throw new Error(`auction ${auction.id}: cannot close`);

      const next = await this.auctions.transition({
        id: auction.id,
        from: 'OPEN',
        to: move.to,
        reason: move.reason,
        patch: unsoldReason
          ? { closedAt: auction.endsAt, returnPending: auction.unitHeld }
          : {
              closedAt: auction.endsAt,
              winnerId: auction.leaderId,
              finalPriceMinor: auction.priceMinor,
            },
        actor: 'system:close',
        at: now,
      });
      if (!next) throw new Error(`auction ${auction.id}: close lost the race`);

      await this.outbox.append(
        AuctionClosed.create(
          next.id,
          next.version,
          {
            ...eventBase(next),
            status: unsoldReason ? 'UNSOLD' : 'CLOSED',
            winnerId: unsoldReason ? null : auction.leaderId,
            finalPriceMinor: unsoldReason ? null : auction.priceMinor,
            currency: next.currency,
            reserveMet,
            reason: unsoldReason ?? 'winner',
          },
          now,
        ),
      );
      if (unsoldReason) {
        if (auction.unitHeld)
          await this.jobs.enqueue(
            'auctions.return-stock',
            { auctionId },
            { idempotencyKey: `auction-return:${auctionId}` },
          );
      } else {
        await this.jobs.enqueue(
          'auctions.request-order',
          { auctionId, step: 'winner' },
          { idempotencyKey: `auction-order:${auctionId}:winner` },
        );
      }
      this.publisher.closed(next);
      closedCounter.add(1, {
        status: unsoldReason ? 'UNSOLD' : 'CLOSED',
        reason: unsoldReason ?? 'winner',
      });
      closeLag.record(
        Math.max(0, now.getTime() - auction.endsAt.getTime()) / 1000,
      );
      return unsoldReason
        ? { kind: 'unsold', auction: next }
        : { kind: 'closed', auction: next };
    });
  }

  /** One close job per `(auction, end)`: idempotent by key, so a repeat creates nothing. */
  private async armClose(auction: AuctionRecord): Promise<void> {
    await this.jobs.enqueue(
      'auctions.close',
      { auctionId: auction.id },
      {
        runAt: auction.endsAt,
        idempotencyKey: `auction-close:${auction.id}:${auction.endsAt.getTime()}`,
      },
    );
  }

  /** The safety net for lost close jobs: `OPEN` auctions whose end has passed (FR-027). */
  async sweepDue(): Promise<number> {
    const now = this.clock.now();
    const ids = await this.auctions.findDue(now, SWEEP_BATCH);
    let closed = 0;
    for (const id of ids) {
      try {
        const outcome = await this.closeIfDue(id);
        if (outcome === 'closed' || outcome === 'unsold') closed++;
      } catch (error) {
        this.logger.warn(
          `sweep close of auction ${id} failed: ${(error as Error).message}`,
        );
      }
    }
    // what is still open more than a minute past its end (a close that keeps failing): the alert reads this
    openOverdue.set(
      await this.auctions.countOverdue(
        new Date(this.clock.now().getTime() - OVERDUE_AFTER_MS),
      ),
    );
    return closed;
  }
}
