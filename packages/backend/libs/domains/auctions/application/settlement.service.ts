import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  AUCTION_REPOSITORY,
  AUCTION_SETTINGS,
  BID_REPOSITORY,
  ORDER_REQUEST,
  SHOP_MEMBERSHIP,
  type AuctionRecord,
  type AuctionRepository,
  type BidRepository,
  type OrderRequestPort,
  type ShopMembershipPort,
} from '../domain/auction-ports';
import type { AuctionSettings } from '../domain/auction-config';
import {
  orderRequestFailedCounter,
  secondChanceCounter,
  settlementAnomalyCounter,
} from '../domain/auction-metrics';
import { transition } from '../domain/auction-state';
import { rankRunnersUp, selectRunnerUp } from '../domain/runner-up';
import {
  AUCTION_CRASH_POINT,
  SimulatedCrash,
  type CrashPoint,
} from './auction-test-seams';
import { auctionSpan } from './auction-tracing';
import { AuctionPublisher } from './auction-publisher';
import {
  AuctionSecondChanceOffered,
  AuctionSold,
  AuctionUnsold,
  eventBase,
} from './events/auction-events';

import './auction.job-types';

/** At most this many runners-up are checked for membership before giving up (one batch, then stop). */
const MAX_CANDIDATES = 20;
const REQUEST_REPAIR_AFTER_MS = 60_000;
const SWEEP_BATCH = 200;

export type RequestOutcome = 'unknown' | 'noop' | 'stored' | 'unpaid';
export type OrderEventOutcome =
  'ignored' | 'unknown_order' | 'held' | 'applied' | 'anomaly';

export type Step = 'winner' | 'second-chance';

/**
 * The winner's order and what comes after (S21 FR-028–FR-031). After the close commits, one idempotent command asks
 * `orders` for the winner's order (key `auction:<id>:winner`); `order.paid` then moves the auction to `SOLD`, and an
 * order that was cancelled, lapsed or refused sends the unit once to the runner-up (key `auction:<id>:second-chance`,
 * at their own maximum) or back to the shelf. Everything is a conditional transition under the auction's lock, so a
 * duplicate, late or reordered event moves nothing backwards.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    @Inject(AUCTION_REPOSITORY) private readonly auctions: AuctionRepository,
    @Inject(BID_REPOSITORY) private readonly bids: BidRepository,
    @Inject(SHOP_MEMBERSHIP) private readonly membership: ShopMembershipPort,
    @Inject(ORDER_REQUEST) private readonly orders: OrderRequestPort,
    @Inject(AUCTION_SETTINGS) private readonly settings: AuctionSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUCTION_CRASH_POINT) private readonly crash: CrashPoint,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly publisher: AuctionPublisher,
  ) {}

  // ------------------------------------------------------------------ the order request

  /**
   * `auctions.request-order`: runs outside any transaction. A transient failure throws (the job retries with backoff,
   * at most 8 attempts, then dead-letters); a permanent refusal is handled as an unpaid winner.
   */
  requestOrder(auctionId: string, step: Step): Promise<RequestOutcome> {
    return auctionSpan(
      'auction.request_order',
      { auctionId, step },
      async () => {
        const outcome = await this.request(auctionId, step);
        this.logger.log({
          event: 'auction.request_order',
          auctionId,
          step,
          outcome,
        });
        return outcome;
      },
    );
  }

  private async request(
    auctionId: string,
    step: Step,
  ): Promise<RequestOutcome> {
    const auction = await this.auctions.findById(auctionId);
    if (!auction) return 'unknown';
    const expected = step === 'winner' ? 'CLOSED' : 'SECOND_CHANCE';
    if (
      auction.status !== expected ||
      auction.winnerOrderId !== null ||
      auction.winnerId === null ||
      auction.finalPriceMinor === null
    )
      return 'noop';
    const reservedUntil =
      step === 'winner'
        ? new Date(
            (auction.closedAt ?? auction.endsAt).getTime() +
              this.settings.winnerWindowMs,
          )
        : auction.offerExpiresAt;
    if (!reservedUntil) return 'noop';

    await this.crash.hit('settlement.before_request');
    const answer = await this.orders.request({
      idempotencyKey: `auction:${auction.id}:${step}`,
      buyerId: auction.winnerId,
      shopId: auction.shopId,
      productId: auction.productId,
      unitPriceMinor: auction.finalPriceMinor,
      currency: auction.currency,
      titleSnapshot: auction.title,
      reservedUntil,
      auctionId: auction.id,
      step,
    });
    if (!answer.ok) {
      orderRequestFailedCounter.add(1, { kind: 'rejected' });
      await this.unpaid(auction.id, `rejected:${answer.code}`);
      return 'unpaid';
    }
    await this.auctions.storeOrder(auction.id, step, answer.orderId);
    return 'stored';
  }

  /** A transient failure of the request (one attempt): counted by kind; the last attempt is the dead letter. */
  requestFailed(isLastAttempt: boolean): void {
    orderRequestFailedCounter.add(1, {
      kind: isLastAttempt ? 'dead_letter' : 'transient',
    });
  }

  // ------------------------------------------------------------------ order events

  /** `order.paid`: the awardee paid, the auction is `SOLD`. */
  async onOrderPaid(event: {
    orderId: string;
    orderVersion: number;
    userId: string;
    totalMinor: number;
  }): Promise<OrderEventOutcome> {
    const found = await this.auctions.findBySettlementOrder(event.orderId);
    if (!found) return this.unknownOrder(event.userId, event.totalMinor);
    return this.runner.run(async (): Promise<OrderEventOutcome> => {
      const auction = await this.auctions.lockById(found.auction.id);
      if (!auction) return 'ignored';
      const current = auction.winnerOrderId === event.orderId;
      if (!current) {
        // the first order paid after its offer began (or ended): money arrived for a sale that is not ours any more
        if (
          auction.firstOrderId === event.orderId &&
          auction.status !== 'CLOSED'
        ) {
          this.anomaly(auction, event.orderId);
          return 'anomaly';
        }
        return 'ignored';
      }
      if (auction.status !== 'CLOSED' && auction.status !== 'SECOND_CHANCE')
        return 'ignored';
      if (
        !(await this.auctions.advanceSettlementVersion(
          auction.id,
          event.orderVersion,
        ))
      )
        return 'ignored';

      const viaSecondChance = auction.status === 'SECOND_CHANCE';
      const move = transition(auction.status, { type: 'settlePaid' });
      if (!move.ok) return 'ignored';
      const now = this.clock.now();
      const next = await this.auctions.transition({
        id: auction.id,
        from: auction.status,
        to: move.to,
        reason: null,
        actor: 'system:order-event',
        at: now,
      });
      if (!next) return 'ignored';
      await this.outbox.append(
        AuctionSold.create(
          next.id,
          next.version,
          {
            ...eventBase(next),
            buyerId: event.userId,
            finalPriceMinor: next.finalPriceMinor ?? event.totalMinor,
            currency: next.currency,
            orderId: event.orderId,
            viaSecondChance,
          },
          now,
        ),
      );
      if (viaSecondChance) secondChanceCounter.add(1, { result: 'sold' });
      this.publisher.changed(next);
      return 'applied';
    });
  }

  /** `order.cancelled` (cancelled, expired or payment failed): the unit goes to the runner-up once, or back. */
  async onOrderCancelled(event: {
    orderId: string;
    orderVersion: number;
    userId: string;
    totalMinor?: number;
  }): Promise<OrderEventOutcome> {
    const found = await this.auctions.findBySettlementOrder(event.orderId);
    if (!found) return this.unknownOrder(event.userId, event.totalMinor);
    const auction = found.auction;
    if (auction.winnerOrderId !== event.orderId) return 'ignored';
    if (auction.status !== 'CLOSED' && auction.status !== 'SECOND_CHANCE')
      return 'ignored';
    await this.unpaid(auction.id, `order:${event.orderId}`, {
      orderVersion: event.orderVersion,
    });
    return 'applied';
  }

  /**
   * An order we do not know. If it is the one a request created whose answer is not stored yet, it must be held for
   * redelivery (the caller raises a transient error), not acknowledged as done (AS-39).
   */
  private async unknownOrder(
    userId: string,
    totalMinor: number | undefined,
  ): Promise<OrderEventOutcome> {
    if (totalMinor === undefined) return 'unknown_order';
    const waiting = await this.auctions.findAwaitingOrder(userId, totalMinor);
    return waiting ? 'held' : 'unknown_order';
  }

  private anomaly(auction: AuctionRecord, orderId: string): void {
    settlementAnomalyCounter.add(1, { kind: 'late_payment' });
    this.logger.warn({
      event: 'auction.settlement_anomaly',
      kind: 'late_payment',
      auctionId: auction.id,
      orderId,
      status: auction.status,
    });
  }

  // ------------------------------------------------------------------ unpaid: second chance or back to the shelf

  /**
   * The awardee did not pay (order cancelled or lapsed, or refused at creation): `CLOSED` offers the unit once to the
   * best eligible runner-up, `SECOND_CHANCE` gives it back. Repeating it changes nothing (the state moved on).
   */
  async unpaid(
    auctionId: string,
    trigger: string,
    guard?: { orderVersion: number },
  ): Promise<void> {
    const auction = await this.auctions.findById(auctionId);
    if (!auction) return;
    if (auction.status === 'SECOND_CHANCE') {
      await this.giveBack(
        auctionId,
        'SECOND_CHANCE',
        'second_chance_unpaid',
        trigger,
        guard,
      );
      return;
    }
    if (auction.status !== 'CLOSED') return;

    // outside any transaction: the candidates and their membership
    const ranked = rankRunnersUp(
      await this.bids.runnerUpCandidates(auctionId),
      {
        winnerId: auction.winnerId,
        reservePriceMinor: auction.reservePriceMinor,
      },
    ).slice(0, MAX_CANDIDATES);
    const members = ranked.length
      ? await this.membership.membersAmong(
          auction.shopId,
          ranked.map((c) => c.bidderId),
        )
      : new Set<string>();
    const chosen = selectRunnerUp(ranked, members);
    if (!chosen) {
      secondChanceCounter.add(1, { result: 'none' });
      await this.giveBack(auctionId, 'CLOSED', 'winner_unpaid', trigger, guard);
      return;
    }

    const now = this.clock.now();
    await this.runner.run(async () => {
      const locked = await this.auctions.lockById(auctionId);
      if (!locked || locked.status !== 'CLOSED') return;
      if (
        guard &&
        !(await this.auctions.advanceSettlementVersion(
          auctionId,
          guard.orderVersion,
        ))
      )
        return;
      const move = transition('CLOSED', { type: 'offerSecondChance' });
      if (!move.ok) return;
      const expiresAt = new Date(now.getTime() + this.settings.offerWindowMs);
      const next = await this.auctions.transition({
        id: auctionId,
        from: 'CLOSED',
        to: move.to,
        reason: null,
        patch: {
          winnerId: chosen.bidderId,
          finalPriceMinor: chosen.maxAmountMinor,
          offerExpiresAt: expiresAt,
          winnerOrderId: null,
        },
        actor: 'system:order-event',
        at: now,
      });
      if (!next) return;
      await this.outbox.append(
        AuctionSecondChanceOffered.create(
          next.id,
          next.version,
          {
            ...eventBase(next),
            offeredToId: chosen.bidderId,
            priceMinor: chosen.maxAmountMinor,
            currency: next.currency,
            expiresAt: expiresAt.toISOString(),
          },
          now,
        ),
      );
      await this.jobs.enqueue(
        'auctions.request-order',
        { auctionId, step: 'second-chance' },
        { idempotencyKey: `auction-order:${auctionId}:second-chance` },
      );
      secondChanceCounter.add(1, { result: 'offered' });
      this.publisher.changed(next);
    });
    this.logger.log({ event: 'auction.second_chance', auctionId, trigger });
  }

  /** `CLOSED | SECOND_CHANCE → UNSOLD(reason)` with the unit going back through the return job. */
  private async giveBack(
    auctionId: string,
    from: 'CLOSED' | 'SECOND_CHANCE',
    reason: 'winner_unpaid' | 'second_chance_unpaid',
    trigger: string,
    guard?: { orderVersion: number },
  ): Promise<void> {
    const now = this.clock.now();
    await this.runner.run(async () => {
      const locked = await this.auctions.lockById(auctionId);
      if (!locked || locked.status !== from) return;
      if (
        guard &&
        !(await this.auctions.advanceSettlementVersion(
          auctionId,
          guard.orderVersion,
        ))
      )
        return;
      const move = transition(from, { type: 'settleUnpaid', reason });
      if (!move.ok) return;
      const next = await this.auctions.transition({
        id: auctionId,
        from,
        to: move.to,
        reason: move.reason,
        patch: { returnPending: locked.unitHeld },
        actor: 'system:order-event',
        at: now,
      });
      if (!next) return;
      await this.outbox.append(
        AuctionUnsold.create(
          next.id,
          next.version,
          { ...eventBase(next), reason },
          now,
        ),
      );
      if (locked.unitHeld)
        await this.jobs.enqueue(
          'auctions.return-stock',
          { auctionId },
          { idempotencyKey: `auction-return:${auctionId}` },
        );
      if (reason === 'second_chance_unpaid')
        secondChanceCounter.add(1, { result: 'unpaid' });
      this.publisher.changed(next);
    });
    this.logger.log({ event: 'auction.unsold', auctionId, reason, trigger });
  }

  // ------------------------------------------------------------------ sweeper part

  /** Awarded auctions whose order was never recorded (a lost job): ask again, the command is idempotent. */
  async repairOrders(): Promise<number> {
    const stuck = await this.auctions.findClosedWithoutOrder(
      new Date(this.clock.now().getTime() - REQUEST_REPAIR_AFTER_MS),
      SWEEP_BATCH,
    );
    let repaired = 0;
    for (const auction of stuck) {
      try {
        const step: Step =
          auction.status === 'CLOSED' ? 'winner' : 'second-chance';
        if ((await this.requestOrder(auction.id, step)) === 'stored')
          repaired++;
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        this.logger.warn(
          `order request of auction ${auction.id} failed: ${(error as Error).message}`,
        );
      }
    }
    return repaired;
  }
}
