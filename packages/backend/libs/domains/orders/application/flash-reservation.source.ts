import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v5 as uuidv5 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  Domain_RateLimitedError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import { retryAfterSeconds } from '../domain/flash-admission';
import {
  FlashSaleBusyError,
  FlashSaleUnavailableError,
} from '../domain/flash-errors';
import {
  FLASH_CRASH_POINT,
  FLASH_FAST_STORE,
  FLASH_RANDOM,
  FLASH_SALE_DIRECTORY,
  SimulatedCrash,
  type CrashPoint,
  type FlashFastStore,
  type FlashHold,
  type FlashLine,
  type FlashRandom,
  type FlashReservationPort,
  type FlashReservationRow,
  type FlashReserveResult,
  type FlashSaleDirectory,
  type OpenSale,
} from '../domain/flash-ports';
import { RequestContext } from '@app/infrastructure/context';
import { FlashSoldOutService } from './flash-sold-out.service';
import { flashSpan } from './flash-tracing';
import {
  flashAdmissionRejectedCounter,
  flashReservationsCounter,
} from '../domain/order-metrics';

/** Namespace of the deterministic claim ids (uuid v5): one claim per sale, buyer, checkout key and product. */
export const FLASH_CLAIM_NAMESPACE = '6f1d3a8e-5b0c-4e8a-9a41-3c2f7d0b1e55';

/**
 * The BEFORE_ORDER seam into S10's checkout (S11 contracts/services.md): finds the open sales, charges the per-buyer
 * attempt limit and the sale admission, takes the units of a drop with all-or-nothing semantics, and later commits,
 * releases or converts them. It never reads a relational table: the sale list comes from the cached directory and the
 * units from the fast store. A fast-store failure fails closed (`FlashSaleUnavailableError`); regular stock is never
 * used as a fallback.
 */
@Injectable()
export class FlashReservationSource implements FlashReservationPort {
  private readonly logger = new Logger(FlashReservationSource.name);

  constructor(
    @Inject(FLASH_SALE_DIRECTORY)
    private readonly directory: FlashSaleDirectory,
    @Inject(FLASH_FAST_STORE) private readonly store: FlashFastStore,
    @Inject(FLASH_RANDOM) private readonly random: FlashRandom,
    @Inject(FLASH_CRASH_POINT) private readonly crash: CrashPoint,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly limiter: RateLimiterService,
    private readonly config: ApiConfigService,
    private readonly soldOut: FlashSoldOutService,
    @Optional() private readonly context?: RequestContext,
  ) {}

  openSales(productIds: string[], now: Date): Promise<Map<string, OpenSale>> {
    return this.directory.openSalesFor(productIds, now);
  }

  anyOpen(now: Date): Promise<boolean> {
    return this.directory.anyOpen(now);
  }

  admit(buyerId: string, sales: OpenSale[]): Promise<void> {
    return flashSpan('flash.admit', { sales: sales.length }, () =>
      this.doAdmit(buyerId, sales),
    );
  }

  reserve(
    buyerId: string,
    key: string,
    lines: FlashLine[],
  ): Promise<FlashReserveResult> {
    return flashSpan('flash.reserve', { lines: lines.length }, () =>
      this.doReserve(buyerId, key, lines),
    );
  }

  private log(fields: Record<string, unknown>): void {
    // ids only: never a buyer's e-mail or a token
    this.logger.log({ requestId: this.context?.requestId, ...fields });
  }

  private async doAdmit(buyerId: string, sales: OpenSale[]): Promise<void> {
    const distinct = [...new Map(sales.map((s) => [s.saleId, s])).values()];
    for (const sale of distinct) {
      const decision = await this.limiter.check(
        'orders.flash-reserve.user',
        `${buyerId}:${sale.saleId}`,
      );
      if (!decision.allowed) {
        if (decision.reason === 'store-unavailable')
          throw new FlashSaleUnavailableError();
        const seconds = Math.max(
          1,
          Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000),
        );
        throw new Domain_RateLimitedError(seconds, {
          'Retry-After': String(seconds),
        });
      }
    }
    for (const sale of distinct) {
      const { admitted } = await this.store.admit(sale, this.clock.nowMs());
      if (!admitted) {
        flashAdmissionRejectedCounter.add();
        this.log({ event: 'flash.admission_rejected', saleId: sale.saleId });
        throw new FlashSaleBusyError(
          retryAfterSeconds(this.random()),
          sale.saleId,
        );
      }
    }
  }

  private async doReserve(
    buyerId: string,
    key: string,
    lines: FlashLine[],
  ): Promise<FlashReserveResult> {
    const taken: FlashHold[] = [];
    const holds: Extract<FlashReserveResult, { kind: 'held' }>['holds'] = [];
    try {
      for (const line of lines) {
        const { sale } = line;
        const claimId = uuidv5(
          `${sale.saleId}|${buyerId}|${key}|${line.productId}`,
          FLASH_CLAIM_NAMESPACE,
        );
        const result = await this.store.claim(sale, {
          claimId,
          buyerId,
          quantity: line.quantity,
          unitPriceMinor: sale.priceMinor,
          startBucket: Math.floor(this.random() * sale.buckets),
          nowMs: this.clock.nowMs(),
          claimWindowMs:
            this.config.get('orders_flash_claim_window_seconds') * 1000,
        });
        if (result.kind === 'out_of_stock' || result.kind === 'stopped') {
          flashReservationsCounter.add(1, { result: 'sold_out' });
          this.log({
            event: 'flash.reserve',
            saleId: sale.saleId,
            result: 'sold_out',
          });
          await this.giveBack(taken);
          return {
            kind: 'rejected',
            productId: line.productId,
            code: 'out_of_stock',
            flashSaleId: sale.saleId,
          };
        }
        if (result.kind === 'limit_exceeded') {
          flashReservationsCounter.add(1, { result: 'limit_exceeded' });
          this.log({
            event: 'flash.reserve',
            saleId: sale.saleId,
            result: 'limit_exceeded',
          });
          await this.giveBack(taken);
          return {
            kind: 'rejected',
            productId: line.productId,
            code: 'limit_exceeded',
            flashSaleId: sale.saleId,
            limit: result.limit,
          };
        }
        taken.push({
          saleId: sale.saleId,
          claimId,
          productId: line.productId,
          quantity: line.quantity,
          unitPriceMinor: sale.priceMinor,
        });
        holds.push({
          productId: line.productId,
          quantity: line.quantity,
          unitPriceMinor: sale.priceMinor,
          sourceRef: claimId,
          flashSaleId: sale.saleId,
        });
        this.log({
          event: 'flash.reserve',
          saleId: sale.saleId,
          claimId,
          result: 'reserved',
          quantity: line.quantity,
        });
        if (result.kind === 'held' && result.lastUnits)
          await this.soldOut.check(sale);
        await this.crash.hit('after-claim');
      }
    } catch (error) {
      // Not "sold out" but a failure: give back what was taken (best effort; the sweeper catches the rest). A
      // simulated crash gives back nothing, as a dead process would not.
      if (!(error instanceof SimulatedCrash)) await this.giveBack(taken);
      throw error;
    }
    flashReservationsCounter.add(holds.length, { result: 'reserved' });
    return { kind: 'held', holds };
  }

  async commit(holds: FlashHold[]): Promise<boolean> {
    let allHeld = true;
    for (const hold of holds) {
      const answer = await this.store.commit(hold.saleId, hold.claimId);
      if (answer === 'not_held') allHeld = false;
    }
    return allHeld;
  }

  release(holds: FlashHold[]): Promise<void> {
    return flashSpan('flash.release', { claims: holds.length }, () =>
      this.giveBack(holds),
    );
  }

  private async giveBack(holds: FlashHold[]): Promise<void> {
    for (const hold of holds) {
      try {
        await this.store.release(hold.saleId, hold.claimId, 'return');
      } catch (error) {
        // The claim stays in the sweeper's set and is returned when its window passes.
        this.logger.warn(
          `release of claim ${hold.claimId} of sale ${hold.saleId} failed: ${(error as Error).name}`,
        );
      }
    }
  }

  releaseReservation(
    row: FlashReservationRow,
  ): Promise<'released' | 'already_released' | 'not_held'> {
    return this.store.release(row.flashSaleId, row.sourceRef, 'return');
  }

  convertReservation(
    row: FlashReservationRow,
  ): Promise<'converted' | 'already_converted' | 'not_held'> {
    return this.store.convert(row.flashSaleId, row.sourceRef);
  }
}
