import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  AuctionCreateRequest,
  AuctionListQuery,
  AuctionMember,
  AuctionPage,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  AuctionHasBidsError,
  AuctionNotCancellableError,
  AuctionNotFoundError,
  DurationOutOfRangeError,
  InsufficientStockError,
  ProductNotFoundError,
  ProductUnavailableError,
  ReserveBelowStartingError,
  StartsTooSoonError,
} from '../domain/auction-errors';
import {
  AUCTION_REPOSITORY,
  AUCTION_SETTINGS,
  AUCTION_STOCK,
  PRODUCT_CATALOG,
  type AuctionRecord,
  type AuctionRepository,
  type AuctionStockPort,
  type ProductCatalogPort,
} from '../domain/auction-ports';
import type { AuctionSettings } from '../domain/auction-config';
import {
  reserveBelowStarting,
  validateSchedule,
} from '../domain/auction-schedule';
import { transition } from '../domain/auction-state';
import { toMemberView } from '../domain/auction-views';
import {
  AUCTION_CRASH_POINT,
  SimulatedCrash,
  type CrashPoint,
} from './auction-test-seams';
import { AuctionPublisher } from './auction-publisher';
import {
  AuctionCancelled,
  AuctionCreated,
  AuctionOpened,
  eventBase,
} from './events/auction-events';

import './auction.job-types';

const HOLD_RETRY_AFTER_MS = 60_000;
const SWEEP_BATCH = 200;

export type HoldOutcome = 'unknown' | 'noop' | 'held' | 'cancelled';
export type OpenOutcome = 'unknown' | 'noop' | 'waiting' | 'opened';
export type ReturnOutcome = 'unknown' | 'noop' | 'returned';

/**
 * Scheduling and the first half of the lifecycle (S21 FR-001–FR-011): create, read, list and cancel an auction, hold
 * and return its unit, open it. Every state change is one conditional transition with its history row, event and jobs
 * written in the same transaction; the unit is moved through the catalog's idempotent stock command, always outside a
 * transaction, by a job (and inline once after the commit, so the answer shows the held unit in the normal case).
 */
@Injectable()
export class AuctionScheduleService {
  private readonly logger = new Logger(AuctionScheduleService.name);

  constructor(
    @Inject(AUCTION_REPOSITORY) private readonly auctions: AuctionRepository,
    @Inject(PRODUCT_CATALOG) private readonly catalog: ProductCatalogPort,
    @Inject(AUCTION_STOCK) private readonly stock: AuctionStockPort,
    @Inject(AUCTION_SETTINGS) private readonly settings: AuctionSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUCTION_CRASH_POINT) private readonly crash: CrashPoint,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
    private readonly publisher: AuctionPublisher,
  ) {}

  // ------------------------------------------------------------------ create

  async create(
    shopId: string,
    userId: string,
    input: AuctionCreateRequest,
  ): Promise<AuctionMember> {
    const now = this.clock.now();
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (reserveBelowStarting(input.startingPriceMinor, input.reservePriceMinor))
      throw new ReserveBelowStartingError();
    const timing = validateSchedule({
      startsAt,
      endsAt,
      now,
      minLeadMs: this.settings.minLeadMs,
      minDurationMs: this.settings.minDurationMs,
      maxDurationMs: this.settings.maxDurationMs,
    });
    if (timing === 'starts_too_soon') throw new StartsTooSoonError();
    if (timing === 'duration_out_of_range') throw new DurationOutOfRangeError();

    // the product of another shop is a plain "not found"; nothing here is written yet
    const product = await this.catalog.getProduct(shopId, input.productId);
    if (!product) throw new ProductNotFoundError();
    if (product.status !== 'ACTIVE') throw new ProductUnavailableError();
    if (product.quantity < 1) throw new InsufficientStockError();

    const id = uuidv7();
    const created = await this.runner.run(async () => {
      const row = await this.auctions.create({
        id,
        shopId,
        productId: input.productId,
        title: input.title,
        currency: product.currency,
        startingPriceMinor: input.startingPriceMinor,
        minIncrementMinor: input.minIncrementMinor,
        reservePriceMinor: input.reservePriceMinor ?? null,
        startsAt,
        endsAt,
        createdAt: now,
        actor: `seller:${userId}`,
      });
      await this.outbox.append(
        AuctionCreated.create(
          row.id,
          row.version,
          {
            ...eventBase(row),
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            currency: row.currency,
          },
          now,
        ),
      );
      await this.jobs.enqueue(
        'auctions.hold-stock',
        { auctionId: id },
        { idempotencyKey: `auction-hold:${id}` },
      );
      await this.jobs.enqueue(
        'auctions.open',
        { auctionId: id },
        { runAt: startsAt, idempotencyKey: `auction-open:${id}` },
      );
      await this.jobs.enqueue(
        'auctions.close',
        { auctionId: id },
        {
          runAt: endsAt,
          idempotencyKey: `auction-close:${id}:${endsAt.getTime()}`,
        },
      );
      return row;
    });

    await this.crash.hit('schedule.after_row');
    await this.tryInline(() => this.holdUnit(id));
    const fresh = (await this.auctions.findById(id)) ?? created;
    return toMemberView(fresh, this.settings.aliasSecret);
  }

  // ------------------------------------------------------------------ reads

  async list(shopId: string, query: AuctionListQuery): Promise<AuctionPage> {
    const page = await this.auctions.listForShop(shopId, query);
    return {
      items: page.items.map((a) => toMemberView(a, this.settings.aliasSecret)),
      nextCursor: page.nextCursor,
    };
  }

  async get(shopId: string, auctionId: string): Promise<AuctionMember> {
    const auction = await this.auctions.findForShop(shopId, auctionId);
    if (!auction) throw new AuctionNotFoundError();
    return toMemberView(auction, this.settings.aliasSecret);
  }

  // ------------------------------------------------------------------ cancel

  /** `SCHEDULED`, or `OPEN` with no bids (FR-008). Serialized with bids by the row lock (AS-09). Repeating is `200`. */
  async cancel(
    shopId: string,
    auctionId: string,
    userId: string,
  ): Promise<AuctionMember> {
    const now = this.clock.now();
    const { auction, changed } = await this.runner.run(async () => {
      const current = await this.auctions.lockById(auctionId);
      if (!current || current.shopId !== shopId)
        throw new AuctionNotFoundError();
      if (current.status === 'CANCELLED')
        return { auction: current, changed: false };
      const move = transition(current.status, {
        type: 'cancel',
        reason: 'seller_cancelled',
        bidCount: current.bidCount,
      });
      if (!move.ok)
        throw move.code === 'auction_has_bids'
          ? new AuctionHasBidsError()
          : new AuctionNotCancellableError(current.status);
      const next = await this.moveToCancelled(
        current,
        'seller_cancelled',
        `seller:${userId}`,
        now,
      );
      return { auction: next, changed: true };
    });
    if (changed && auction.returnPending)
      await this.tryInline(() => this.returnUnit(auctionId));
    const fresh = (await this.auctions.findById(auctionId)) ?? auction;
    return toMemberView(fresh, this.settings.aliasSecret);
  }

  /**
   * The cancelled transition with its history row, `auction.cancelled` event and, when the unit is out of stock, the
   * return job (`returnPending` is set in the same statement). Caller holds the auction lock.
   */
  private async moveToCancelled(
    current: AuctionRecord,
    reason: 'seller_cancelled' | 'stock_hold_failed',
    actor: string,
    now: Date,
    options: { returnWithoutHold?: boolean } = {},
  ): Promise<AuctionRecord> {
    const returnPending =
      current.unitHeld || options.returnWithoutHold === true;
    const next = await this.auctions.transition({
      id: current.id,
      from: current.status,
      to: 'CANCELLED',
      reason,
      patch: { returnPending },
      actor,
      at: now,
    });
    if (!next) throw new Error(`auction ${current.id}: cancel lost the race`);
    await this.outbox.append(
      AuctionCancelled.create(
        next.id,
        next.version,
        { ...eventBase(next), reason },
        now,
      ),
    );
    if (returnPending)
      await this.jobs.enqueue(
        'auctions.return-stock',
        { auctionId: next.id },
        { idempotencyKey: `auction-return:${next.id}` },
      );
    this.publisher.changed(next);
    return next;
  }

  // ------------------------------------------------------------------ job handlers

  /**
   * `auctions.hold-stock` (and the inline call after create): the unit leaves regular stock through
   * `auctions:<id>:hold`. A definitive refusal cancels the auction (`stock_hold_failed`); a transient failure throws
   * and the job retries. A hold that lands after the auction was cancelled is given back.
   */
  async holdUnit(auctionId: string): Promise<HoldOutcome> {
    const auction = await this.auctions.findById(auctionId);
    if (!auction) return 'unknown';
    if (auction.unitHeld || auction.status !== 'SCHEDULED') return 'noop';
    const result = await this.stock.hold(
      auction.id,
      auction.productId,
      auction.shopId,
    );
    if (!result.ok) {
      await this.cancelUnheld(auction.id, false);
      return 'cancelled';
    }
    const recorded = await this.auctions.markUnitHeld(auction.id);
    if (!recorded) {
      // the auction ended while the hold was in flight: the unit that was just taken goes back (idempotent)
      const back = await this.stock.return(
        auction.id,
        auction.productId,
        auction.shopId,
      );
      if (!back.ok)
        throw new Error(`auction ${auction.id}: late return failed`);
      return 'noop';
    }
    await this.openIfDue(auction.id);
    return 'held';
  }

  /** `SCHEDULED → CANCELLED(stock_hold_failed)`; with `returnToo` the return job learns by the idempotent hold. */
  private async cancelUnheld(
    auctionId: string,
    returnToo: boolean,
  ): Promise<void> {
    const now = this.clock.now();
    await this.runner.run(async () => {
      const current = await this.auctions.lockById(auctionId);
      if (!current || current.status !== 'SCHEDULED' || current.unitHeld)
        return;
      await this.moveToCancelled(
        current,
        'stock_hold_failed',
        'system:hold',
        now,
        { returnWithoutHold: returnToo },
      );
    });
  }

  /** `auctions.open` at `startsAt`, the sweeper and the end of a hold: `SCHEDULED → OPEN` once the unit is held. */
  async open(auctionId: string, actor = 'system:open'): Promise<OpenOutcome> {
    const now = this.clock.now();
    return this.runner.run(async () => {
      const current = await this.auctions.lockById(auctionId);
      if (!current) return 'unknown';
      if (current.status !== 'SCHEDULED') return 'noop';
      if (
        !current.unitHeld ||
        now.getTime() < current.startsAt.getTime() ||
        now.getTime() >= current.endsAt.getTime()
      )
        return 'waiting';
      await this.openLocked(current, actor, now);
      return 'opened';
    });
  }

  /** Opens a locked, held, started auction: history, `auction.opened`, cache. Used by the job and by the first bid. */
  async openLocked(
    current: AuctionRecord,
    actor: string,
    now: Date,
  ): Promise<AuctionRecord> {
    const move = transition(current.status, { type: 'open' });
    if (!move.ok) throw new Error(`auction ${current.id}: cannot open`);
    const next = await this.auctions.transition({
      id: current.id,
      from: current.status,
      to: move.to,
      reason: null,
      actor,
      at: now,
    });
    if (!next) throw new Error(`auction ${current.id}: open lost the race`);
    await this.outbox.append(
      AuctionOpened.create(
        next.id,
        next.version,
        { ...eventBase(next), endsAt: next.endsAt.toISOString() },
        now,
      ),
    );
    this.publisher.changed(next);
    return next;
  }

  private async openIfDue(auctionId: string): Promise<void> {
    const auction = await this.auctions.findById(auctionId);
    if (auction && this.clock.now().getTime() >= auction.startsAt.getTime())
      await this.open(auctionId);
  }

  /**
   * `auctions.return-stock`: the unit goes back through `auctions:<id>:return`, a new operation (never a compensation
   * of the hold), at most once. When the hold was never recorded, the idempotent hold tells whether it was applied.
   */
  async returnUnit(auctionId: string): Promise<ReturnOutcome> {
    const auction = await this.auctions.findById(auctionId);
    if (!auction) return 'unknown';
    if (!auction.returnPending) return 'noop';
    if (!auction.unitHeld) {
      const probe = await this.stock.hold(
        auction.id,
        auction.productId,
        auction.shopId,
      );
      if (!probe.ok) {
        await this.auctions.markUnitReturned(auction.id);
        return 'returned';
      }
    }
    const back = await this.stock.return(
      auction.id,
      auction.productId,
      auction.shopId,
    );
    if (!back.ok) throw new Error(`auction ${auction.id}: return refused`);
    await this.auctions.markUnitReturned(auction.id);
    return 'returned';
  }

  // ------------------------------------------------------------------ sweeper parts

  /** Holds that did not complete: retry after 1 min; past the deadline give up and cancel (FR-011). */
  async repairHolds(): Promise<number> {
    const now = this.clock.now();
    const stuck = await this.auctions.findHoldPending(
      new Date(now.getTime() - HOLD_RETRY_AFTER_MS),
      SWEEP_BATCH,
    );
    let repaired = 0;
    for (const auction of stuck) {
      const pastDeadline =
        now.getTime() - auction.holdRequestedAt.getTime() >=
        this.settings.holdDeadlineS * 1000;
      try {
        await this.holdUnit(auction.id);
        repaired++;
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        this.logger.warn(
          `hold of auction ${auction.id} failed: ${(error as Error).message}`,
        );
        if (pastDeadline) await this.cancelUnheld(auction.id, true);
      }
    }
    return repaired;
  }

  /** Returns that are still pending: apply them (the job also retries; both are idempotent). */
  async repairReturns(): Promise<number> {
    const ids = await this.auctions.findReturnPending(SWEEP_BATCH);
    let done = 0;
    for (const id of ids) {
      try {
        if ((await this.returnUnit(id)) === 'returned') done++;
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        this.logger.warn(
          `return of auction ${id} failed: ${(error as Error).message}`,
        );
      }
    }
    return done;
  }

  /** Held auctions whose start has passed but whose open job did not run. */
  async openDue(): Promise<number> {
    const ids = await this.auctions.findDueToOpen(
      this.clock.now(),
      SWEEP_BATCH,
    );
    let opened = 0;
    for (const id of ids)
      if ((await this.open(id, 'system:sweeper')) === 'opened') opened++;
    return opened;
  }

  /** Inline work after a commit: a failure is left to the job, a simulated crash is not swallowed. */
  private async tryInline(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      this.logger.warn(
        `inline step failed, the job retries: ${(error as Error).message}`,
      );
    }
  }
}
