import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  FlashSaleCreateRequest,
  FlashSaleListQuery,
  FlashSaleMember,
  FlashSalePage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  ProductNotFoundError,
  ProductQueryService,
} from '@app/domains/catalog';
import { TransactionRunner } from '@app/infrastructure/context';
import { InvalidScheduleError } from '@app/infrastructure/jobs/job-errors';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import {
  DropPriceAboveRegularError,
  FlashSaleNotFoundError,
  FlashValidationError,
  InsufficientStockError,
} from '../domain/flash-errors';
import {
  FLASH_FAST_STORE,
  FLASH_SALE_REPOSITORY,
  type FlashFastStore,
  type FlashSaleRecord,
  type FlashSaleRepository,
} from '../domain/flash-ports';
import { ProductUnavailableError } from '../domain/order-errors';
import { decodeOrderCursor, encodeOrderCursor } from '../domain/order-cursor';
import { FlashLifecycleService } from './flash-lifecycle.service';

import './order.job-types';

const cursorScope = (shopId: string) => `flash:${shopId}`;

/**
 * Scheduling and reading drops for a seller (S11 FR-001…FR-009). The product is checked through the catalog's R1
 * service outside any transaction; the sale, its history row and its two jobs commit together. Another shop's sale is
 * indistinguishable from a missing one (`flash_sale_not_found`).
 */
@Injectable()
export class FlashSaleService {
  private readonly logger = new Logger(FlashSaleService.name);

  constructor(
    @Inject(FLASH_SALE_REPOSITORY) private readonly sales: FlashSaleRepository,
    @Inject(FLASH_FAST_STORE) private readonly store: FlashFastStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly products: ProductQueryService,
    private readonly jobs: JobsService,
    private readonly runner: TransactionRunner,
    private readonly config: ApiConfigService,
    private readonly lifecycle: FlashLifecycleService,
  ) {}

  async create(
    shopId: string,
    input: FlashSaleCreateRequest,
    actorId: string,
  ): Promise<FlashSaleMember> {
    const now = this.clock.now();
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const fields: string[] = [];
    if (
      startsAt.getTime() - now.getTime() <
      this.config.get('orders_flash_min_lead_seconds') * 1000
    )
      fields.push('startsAt');
    if (
      endsAt.getTime() - startsAt.getTime() >
      this.config.get('orders_flash_max_window_seconds') * 1000
    )
      fields.push('endsAt');
    if (fields.length > 0) throw new FlashValidationError(fields);

    const product = (
      await this.products.getProductsByIds([input.productId], { shopId })
    ).get(input.productId);
    if (!product) throw new ProductNotFoundError();
    if (product.status !== 'ACTIVE' || product.isSandbox)
      throw new ProductUnavailableError([product.id]);
    if (input.units > product.quantity)
      throw new InsufficientStockError(product.quantity);
    if (input.priceMinor > product.priceMinor)
      throw new DropPriceAboveRegularError(product.priceMinor);

    const sale = await this.runner.run(async () => {
      const created = await this.sales.create({
        shopId,
        productId: product.id,
        priceMinor: input.priceMinor,
        currency: product.currency,
        units: input.units,
        buckets: input.buckets,
        perUserLimit: input.perUserLimit,
        admissionRatePerSecond: input.admissionRatePerSecond,
        startsAt,
        endsAt,
      });
      await this.enqueueJobs(created);
      return created;
    });
    this.logger.log(`sale ${sale.id} scheduled by ${actorId}`);
    return this.member(sale);
  }

  private async enqueueJobs(sale: FlashSaleRecord): Promise<void> {
    try {
      await this.jobs.enqueue(
        'flash-sale.load',
        { saleId: sale.id },
        {
          runAt: new Date(
            sale.startsAt.getTime() -
              this.config.get('orders_flash_load_lead_seconds') * 1000,
          ),
          idempotencyKey: `flash-load:${sale.id}`,
          shopId: sale.shopId,
        },
      );
      await this.jobs.enqueue(
        'flash-sale.end',
        { saleId: sale.id },
        {
          runAt: sale.endsAt,
          idempotencyKey: `flash-end:${sale.id}`,
          shopId: sale.shopId,
        },
      );
    } catch (error) {
      if (error instanceof InvalidScheduleError)
        this.logger.error(
          `jobs of sale ${sale.id} not scheduled (flash-sale.load/end): ${error.message}`,
        );
      throw error;
    }
  }

  async get(shopId: string, saleId: string): Promise<FlashSaleMember> {
    const sale = await this.sales.findForShop(shopId, saleId);
    if (!sale) throw new FlashSaleNotFoundError();
    return this.member(sale);
  }

  async list(
    shopId: string,
    query: FlashSaleListQuery,
  ): Promise<FlashSalePage> {
    let after: { startsAt: Date; id: string } | null = null;
    if (query.cursor) {
      const position = decodeOrderCursor(cursorScope(shopId), query.cursor);
      after = { startsAt: new Date(position.createdAt), id: position.id };
    }
    const rows = await this.sales.pageForShop(shopId, {
      status: query.status,
      limit: query.limit + 1,
      after,
    });
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: await Promise.all(page.map((s) => this.member(s))),
      nextCursor:
        rows.length > query.limit && last
          ? encodeOrderCursor(cursorScope(shopId), {
              createdAt: last.startsAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async cancel(
    shopId: string,
    saleId: string,
    actorId: string,
  ): Promise<FlashSaleMember> {
    const sale = await this.sales.findForShop(shopId, saleId);
    if (!sale) throw new FlashSaleNotFoundError();
    const cancelled = await this.lifecycle.cancel(sale, `user:${actorId}`);
    return this.member(cancelled);
  }

  // ------------------------------------------------------------ view

  /**
   * `stats` is exact while loaded (buckets in one pipelined read, reservation sums from the durable table) and comes
   * from the durable records once the sale has ended; `null` while there is nothing to count.
   */
  private async member(sale: FlashSaleRecord): Promise<FlashSaleMember> {
    return {
      id: sale.id,
      shopId: sale.shopId,
      productId: sale.productId,
      priceMinor: sale.priceMinor,
      currency: sale.currency,
      units: sale.units,
      buckets: sale.buckets,
      perUserLimit: sale.perUserLimit,
      admissionRatePerSecond: sale.admissionRatePerSecond,
      startsAt: sale.startsAt.toISOString(),
      endsAt: sale.endsAt.toISOString(),
      status: sale.status,
      statusReason: sale.statusReason,
      stats: await this.stats(sale),
      createdAt: sale.createdAt.toISOString(),
    };
  }

  private async stats(
    sale: FlashSaleRecord,
  ): Promise<FlashSaleMember['stats']> {
    if (sale.status === 'LOADED') {
      const [contents, sums] = await Promise.all([
        this.store.remaining(sale.id, sale.buckets).catch(() => null),
        this.sales.reservationSums(sale.id),
      ]);
      if (!contents) return null;
      return {
        unitsLoaded: sale.units,
        unitsRemaining: Math.min(
          sale.units,
          contents.reduce((s, c) => s + Math.max(0, c), 0),
        ),
        unitsHeld: sums.held,
        unitsSold: sums.converted,
      };
    }
    if (sale.status === 'ENDED' || sale.status === 'RECONCILED') {
      const sums = await this.sales.reservationSums(sale.id);
      return {
        unitsLoaded: sale.units,
        unitsRemaining: Math.max(0, sale.units - sums.converted - sums.held),
        unitsHeld: sums.held,
        unitsSold: sums.converted,
      };
    }
    return null;
  }
}
