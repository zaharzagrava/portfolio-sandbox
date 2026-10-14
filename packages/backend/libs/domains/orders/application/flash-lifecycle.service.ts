import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ProductStockService } from '@app/domains/catalog';
import { TransactionRunner } from '@app/infrastructure/context';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { classify } from '../domain/flash-drift';
import { splitUnits } from '../domain/flash-bucket-plan';
import { FlashSaleNotCancellableError } from '../domain/flash-errors';
import {
  FLASH_CRASH_POINT,
  FLASH_FAST_STORE,
  FLASH_SALE_DIRECTORY,
  FLASH_SALE_REPOSITORY,
  type CrashPoint,
  type FlashFastStore,
  type FlashSaleDirectory,
  type FlashSaleRecord,
  type FlashSaleRepository,
} from '../domain/flash-ports';
import {
  isOpen,
  transition,
  type FlashSaleStatus,
  type StatusReason,
} from '../domain/flash-sale-state';
import {
  flashClaimsExpiredCounter,
  flashOversellCounter,
  flashPhantomStockCounter,
  flashReconcileWaitingGauge,
  flashStockDriftCounter,
  flashStockRemainingGauge,
} from '../domain/order-metrics';
import { OrderLifecycleService } from './order-lifecycle.service';
import {
  FlashSaleCancelled,
  FlashSaleEnded,
  FlashSaleLoaded,
  FlashSaleOversold,
  FlashSaleReconciled,
  FlashSaleStartFailed,
  withDeterministicId,
} from './events/flash-sale-events';

import './order.job-types';

const MINUTE_MS = 60_000;
/** The S10 hold of an order is 15 minutes; reconciliation starts after the last hold could have expired. */
const HOLD_MS = 15 * MINUTE_MS;
const SWEEP_BATCH = 200;
const WAIT_RETRY_MS = 60_000;
const ACTOR = 'system:job';

export type LoadOutcome =
  'loaded' | 'already_loaded' | 'failed' | 'ignored' | 'unknown';
export type EndOutcome =
  'ended' | 'failed' | 'already_ended' | 'ignored' | 'unknown';
export type ReconcileOutcome =
  'reconciled' | 'waiting' | 'returned' | 'ignored' | 'unknown';

/**
 * The life of a sale after scheduling (S11 FR-006…FR-029): load the units into the fast store, end, reconcile the
 * leftovers back to regular stock exactly once, verify during the sale (clamp phantom stock, stop and remediate an
 * oversell) and give back abandoned claims. Every step is safe to repeat, reorder or crash at: stock moves only through
 * the catalog's `applyStockDelta` under `orders:flash:<saleId>:load|return`, buckets are created if absent, status
 * changes are conditional updates, and each transition writes its history row and outbox event in one transaction.
 */
@Injectable()
export class FlashLifecycleService {
  private readonly logger = new Logger(FlashLifecycleService.name);

  constructor(
    @Inject(FLASH_SALE_REPOSITORY) private readonly sales: FlashSaleRepository,
    @Inject(FLASH_FAST_STORE) private readonly store: FlashFastStore,
    @Inject(FLASH_SALE_DIRECTORY)
    private readonly directory: FlashSaleDirectory,
    @Inject(FLASH_CRASH_POINT) private readonly crash: CrashPoint,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly stock: ProductStockService,
    private readonly orders: OrderLifecycleService,
    private readonly jobs: JobsService,
    private readonly outbox: OutboxService,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
  ) {}

  // ------------------------------------------------------------ transitions

  /** Conditional move + history + event in one transaction; `null` when the sale was no longer in `from`. */
  private async transit(
    sale: FlashSaleRecord,
    to: FlashSaleStatus,
    reason: StatusReason | undefined,
    actor: string,
    event: (moved: FlashSaleRecord) => EventEnvelope,
    extra?: (moved: FlashSaleRecord) => Promise<void>,
  ): Promise<FlashSaleRecord | null> {
    const moved = await this.runner.run(async () => {
      const result = await this.sales.move(
        sale.id,
        sale.status,
        to,
        { reason },
        actor,
        this.clock.now(),
      );
      if (!result) return null;
      await this.outbox.append(withDeterministicId(event(result)));
      if (extra) await extra(result);
      return result;
    });
    // The cached list of loaded sales is at most 2 s old anyway; a state change makes the next read current.
    if (moved) await this.directory.refresh().catch(() => undefined);
    return moved;
  }

  private base = (s: FlashSaleRecord) => ({
    saleId: s.id,
    shopId: s.shopId,
    productId: s.productId,
  });

  private loadOp = (s: FlashSaleRecord) => ({
    operationId: `orders:flash:${s.id}:load`,
    productId: s.productId,
    shopId: s.shopId,
    delta: -s.units,
    reason: 'flash.load',
  });

  private returnOp = (s: FlashSaleRecord, units: number) => ({
    operationId: `orders:flash:${s.id}:return`,
    productId: s.productId,
    shopId: s.shopId,
    delta: units,
    reason: 'flash.return',
  });

  // ------------------------------------------------------------ load

  async load(saleId: string, actor = ACTOR): Promise<LoadOutcome> {
    const sale = await this.sales.find(saleId);
    if (!sale) return 'unknown';
    const now = this.clock.now();
    const decision = transition(sale.status, { type: 'load' }, now, sale);
    if (decision.kind === 'already') return 'already_loaded';
    if (decision.kind === 'illegal') {
      this.logger.log(`load of sale ${saleId} ignored in ${sale.status}`);
      return 'ignored';
    }
    // Past the start the drop cannot open on time; a crash-retry that late must not load it.
    if (now.getTime() >= sale.startsAt.getTime())
      return this.fail(sale, 'window_missed', true, actor);

    const result = await this.stock.applyStockDelta([this.loadOp(sale)]);
    if (result.outcome === 'rejected') {
      const code = result.failures[0]?.code;
      return this.fail(
        sale,
        code === 'insufficient_stock' || code === 'quantity_limit'
          ? 'insufficient_stock'
          : 'product_unavailable',
        false,
        actor,
      );
    }
    await this.crash.hit('load:after-stock');

    await this.store.fillBuckets(
      {
        saleId: sale.id,
        buckets: sale.buckets,
        units: sale.units,
        perUserLimit: sale.perUserLimit,
        admissionRatePerSecond: sale.admissionRatePerSecond,
        startsAt: sale.startsAt,
        endsAt: sale.endsAt,
      },
      splitUnits(sale.units, sale.buckets),
    );
    await this.crash.hit('load:after-buckets');

    if (this.clock.now().getTime() >= sale.startsAt.getTime())
      return this.fail(sale, 'window_missed', true, actor);

    const moved = await this.transit(sale, 'LOADED', undefined, actor, (m) =>
      FlashSaleLoaded.create(m.id, m.version, {
        ...this.base(m),
        units: m.units,
        buckets: m.buckets,
        startsAt: m.startsAt.toISOString(),
        endsAt: m.endsAt.toISOString(),
      }),
    );
    return moved ? 'loaded' : 'already_loaded';
  }

  /** `SCHEDULED → START_FAILED`; units taken for a sale that cannot open come back through the return operation. */
  private async fail(
    sale: FlashSaleRecord,
    reason: StatusReason,
    reverse: boolean,
    actor: string,
  ): Promise<'failed'> {
    if (reverse) {
      await this.reverseLoad(sale);
      await this.store.dropSale(sale.id, sale.buckets).catch(() => undefined);
    }
    await this.transit(sale, 'START_FAILED', reason, actor, (m) =>
      FlashSaleStartFailed.create(m.id, m.version, {
        ...this.base(m),
        reason,
      }),
    );
    return 'failed';
  }

  /**
   * Undoes a load that may or may not have happened: applying the load again is a replay when it did and takes the
   * units when it did not; either way the return puts them back, so the net effect on regular stock is zero.
   */
  private async reverseLoad(sale: FlashSaleRecord): Promise<void> {
    const taken = await this.stock.applyStockDelta([this.loadOp(sale)]);
    if (taken.outcome === 'rejected') return;
    await this.crash.hit('reverse:after-load');
    const back = await this.stock.applyStockDelta([
      this.returnOp(sale, sale.units),
    ]);
    if (back.outcome === 'rejected')
      throw new Error(`flash sale ${sale.id}: return of units was rejected`);
  }

  // ------------------------------------------------------------ end

  async end(saleId: string, actor = ACTOR): Promise<EndOutcome> {
    const sale = await this.sales.find(saleId);
    if (!sale) return 'unknown';
    const decision = transition(
      sale.status,
      { type: 'end' },
      this.clock.now(),
      sale,
    );
    if (decision.kind === 'already') return 'already_ended';
    if (decision.kind === 'illegal') return 'ignored';
    if (decision.to === 'START_FAILED') {
      // Never loaded: its window is over. Units may have been taken by a load that crashed before its move.
      await this.fail(sale, 'window_missed', true, actor);
      return 'failed';
    }
    const reconcileAt = new Date(sale.endsAt.getTime() + HOLD_MS + MINUTE_MS);
    await this.transit(
      sale,
      'ENDED',
      undefined,
      actor,
      (m) => FlashSaleEnded.create(m.id, m.version, this.base(m)),
      async (m) => {
        await this.jobs.enqueue(
          'flash-sale.reconcile',
          { saleId: m.id },
          {
            runAt: reconcileAt,
            idempotencyKey: `flash-reconcile:${m.id}`,
            shopId: m.shopId,
          },
        );
      },
    );
    return 'ended';
  }

  // ------------------------------------------------------------ cancel

  /**
   * The seller cancels before the start. `SCHEDULED`: the jobs are cancelled. `LOADED`: the units are returned by the
   * reconciliation, run right away (and retried by its job when the catalog is not reachable). A repeat answers the
   * same sale; a started or finished sale is `409 flash_sale_not_cancellable`.
   */
  async cancel(sale: FlashSaleRecord, actor: string): Promise<FlashSaleRecord> {
    let current = sale;
    for (let attempt = 0; attempt < 3; attempt++) {
      const decision = transition(
        current.status,
        { type: 'cancel' },
        this.clock.now(),
        current,
      );
      if (decision.kind === 'already') return current;
      if (decision.kind === 'illegal')
        throw new FlashSaleNotCancellableError(current.status);
      const wasLoaded = current.status === 'LOADED';
      const moved = await this.transit(
        current,
        'CANCELLED',
        'cancelled_by_shop',
        actor,
        (m) => FlashSaleCancelled.create(m.id, m.version, this.base(m)),
        async (m) => {
          await this.jobs.cancelByKey(`flash-load:${m.id}`);
          await this.jobs.cancelByKey(`flash-end:${m.id}`);
          if (wasLoaded)
            await this.jobs.enqueue(
              'flash-sale.reconcile',
              { saleId: m.id },
              {
                idempotencyKey: `flash-reconcile:${m.id}`,
                shopId: m.shopId,
              },
            );
        },
      );
      if (moved) {
        if (wasLoaded)
          await this.reconcile(moved.id).catch((error: unknown) =>
            this.logger.warn(
              `early reconcile of sale ${moved.id} failed, its job retries: ${(error as Error).name}`,
            ),
          );
        return moved;
      }
      const fresh = await this.sales.find(current.id);
      if (!fresh) throw new FlashSaleNotCancellableError();
      current = fresh;
    }
    throw new FlashSaleNotCancellableError(current.status);
  }

  // ------------------------------------------------------------ reconcile

  async reconcile(saleId: string, actor = ACTOR): Promise<ReconcileOutcome> {
    const sale = await this.sales.find(saleId);
    if (!sale) return 'unknown';
    const cancelledAfterLoad =
      sale.status === 'CANCELLED' && (await this.sales.everLoaded(sale.id));
    if (sale.status === 'RECONCILED') return 'ignored';
    if (sale.status !== 'ENDED' && !cancelledAfterLoad) return 'ignored';

    const sums = await this.sales.reservationSums(sale.id);
    if (sums.heldRows > 0 || sums.releasePendingRows > 0) {
      await this.waitForHolds(sale);
      return 'waiting';
    }
    flashReconcileWaitingGauge.set(0);

    const sold = sums.converted;
    const unsold = Math.max(0, sale.units - sold);
    const driftUnits = await this.measureDrift(sale, sold);

    if (unsold > 0) {
      const result = await this.stock.applyStockDelta([
        this.returnOp(sale, unsold),
      ]);
      if (result.outcome === 'rejected')
        throw new Error(`flash sale ${sale.id}: return of units was rejected`);
    }
    await this.crash.hit('reconcile:after-return');
    await this.store.dropSale(sale.id, sale.buckets);
    if (cancelledAfterLoad) return 'returned';

    await this.transit(sale, 'RECONCILED', undefined, actor, (m) =>
      FlashSaleReconciled.create(m.id, m.version, {
        ...this.base(m),
        units: m.units,
        unitsSold: sold,
        unitsReturned: unsold,
        driftUnits,
      }),
    );
    return 'reconciled';
  }

  /**
   * Records how far the store was from the durable records (signed: store minus records); the records win, the
   * difference is only measured.
   */
  private async measureDrift(
    sale: FlashSaleRecord,
    sold: number,
  ): Promise<number> {
    let remainingFast: number;
    try {
      const contents = await this.store.remaining(sale.id, sale.buckets);
      remainingFast = contents.reduce((s, c) => s + Math.max(0, c), 0);
    } catch {
      this.logger.warn(
        `sale ${sale.id}: fast store not readable at reconcile, drift not measured`,
      );
      return 0;
    }
    const drift = classify({
      units: sale.units,
      remainingFast,
      reserved: sold,
      phase: 'after',
    });
    if (drift.kind === 'redis_low' || drift.kind === 'redis_high') {
      const low = drift.kind === 'redis_low';
      flashStockDriftCounter.add(drift.driftUnits, {
        direction: low ? 'low' : 'high',
      });
      this.logger.warn(
        `sale ${sale.id}: fast store ${drift.kind} by ${drift.driftUnits} units at reconcile; durable records win`,
      );
      return low ? -drift.driftUnits : drift.driftUnits;
    }
    return 0;
  }

  /** Units are still held by orders: look again in 60 s, and shout when it takes too long. */
  private async waitForHolds(sale: FlashSaleRecord): Promise<void> {
    const now = this.clock.now();
    flashReconcileWaitingGauge.set(1);
    const waitedSeconds =
      (now.getTime() - (sale.endsAt.getTime() + HOLD_MS)) / 1000;
    if (
      waitedSeconds >
      this.config.get('orders_flash_reconcile_wait_alert_seconds')
    )
      this.logger.error(
        `flash sale ${sale.id} reconciliation has waited ${Math.round(waitedSeconds)} s for holds`,
      );
    await this.jobs.enqueue(
      'flash-sale.reconcile',
      { saleId: sale.id },
      {
        runAt: new Date(now.getTime() + WAIT_RETRY_MS),
        idempotencyKey: `flash-reconcile:${sale.id}:${Math.floor(now.getTime() / WAIT_RETRY_MS)}`,
        shopId: sale.shopId,
      },
    );
  }

  // ------------------------------------------------------------ verify

  /** Every open sale: clamp phantom stock down; stop selling and cancel the newest unpaid orders on an oversell. */
  async verify(): Promise<void> {
    const now = this.clock.now();
    for (const sale of await this.sales.loadedAndLive(now)) {
      if (!isOpen(sale, now)) continue;
      try {
        await this.verifySale(sale);
      } catch (error) {
        this.logger.warn(
          `verification of sale ${sale.id} failed: ${(error as Error).name}`,
        );
      }
    }
  }

  private async verifySale(sale: FlashSaleRecord): Promise<void> {
    const contents = await this.store.remaining(sale.id, sale.buckets);
    const remainingFast = contents.reduce((s, c) => s + Math.max(0, c), 0);
    const sums = await this.sales.reservationSums(sale.id);
    const reserved = sums.held + sums.converted;
    flashStockRemainingGauge.set(remainingFast, { saleId: sale.id });

    const drift = classify({
      units: sale.units,
      remainingFast,
      reserved,
      phase: 'during',
    });
    if (drift.kind === 'phantom_stock') {
      await this.store.clamp(sale.id, sale.buckets, drift.clampTo);
      flashPhantomStockCounter.add(drift.excess);
      this.logger.warn(
        `sale ${sale.id}: ${drift.excess} phantom units clamped away from the fast store`,
      );
    } else if (drift.kind === 'oversold') {
      await this.remediateOversell(sale, drift.excess);
    }
  }

  private async remediateOversell(
    sale: FlashSaleRecord,
    excess: number,
  ): Promise<void> {
    const newlyStopped = await this.store.stopSelling(sale.id);
    const beyond = await this.sales.newestUnpaidOrdersBeyond(
      sale.id,
      sale.units,
    );
    const cancelled: string[] = [];
    let cancelledUnits = 0;
    for (const order of beyond) {
      // The units were never real: they are retired, not returned to the buckets.
      await this.store.release(sale.id, order.claimId, 'discard');
      const result = await this.orders.transition(
        order.orderId,
        { type: 'cancel', reason: 'out_of_stock' },
        { actor: 'system:flash-verify' },
      );
      if (result.kind === 'applied' || result.kind === 'already_applied') {
        cancelled.push(order.orderId);
        cancelledUnits += order.units;
      }
    }
    flashOversellCounter.add(cancelledUnits || (newlyStopped ? excess : 0));
    if (!newlyStopped && cancelled.length === 0) return;
    const unresolvedPaidUnits = Math.max(0, excess - cancelledUnits);
    await this.runner.run(() =>
      this.outbox.append(
        withDeterministicId(
          FlashSaleOversold.create(sale.id, sale.version, {
            ...this.base(sale),
            excessUnits: excess,
            cancelledOrderIds: cancelled,
            unresolvedPaidUnits,
          }),
          this.clock.nowMs(),
        ),
      ),
    );
    this.logger.error(
      `sale ${sale.id} oversold by ${excess} units; ${cancelled.length} orders cancelled, ${unresolvedPaidUnits} paid units unresolved`,
    );
  }

  // ------------------------------------------------------------ claim sweeper

  /** Abandoned claims: a durable order keeps the units (commit), none gives them back; interrupted releases resume. */
  async sweepClaims(): Promise<number> {
    const now = this.clock.now();
    let handled = 0;
    for (const sale of await this.sales.loadedAndLive(now)) {
      let ids: string[];
      try {
        ids = await this.store.expiredClaims(
          sale.id,
          this.clock.nowMs(),
          SWEEP_BATCH,
        );
      } catch (error) {
        this.logger.warn(
          `claim sweep of sale ${sale.id} failed: ${(error as Error).name}`,
        );
        continue;
      }
      for (const claimId of ids) {
        try {
          const row = await this.sales.reservationByClaim(claimId);
          if (row && (row.status === 'HELD' || row.status === 'CONVERTED')) {
            await this.store.commit(sale.id, claimId);
          } else {
            const answer = await this.store.release(sale.id, claimId, 'return');
            if (!row && answer === 'released') flashClaimsExpiredCounter.add();
          }
          handled += 1;
        } catch (error) {
          this.logger.warn(
            `sweep of claim ${claimId} failed: ${(error as Error).name}`,
          );
        }
      }
    }
    return handled;
  }
}
