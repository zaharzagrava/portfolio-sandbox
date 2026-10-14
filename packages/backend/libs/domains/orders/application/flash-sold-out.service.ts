import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  FLASH_FAST_STORE,
  type FlashFastStore,
  type OpenSale,
} from '../domain/flash-ports';
import {
  FlashSaleSoldOut,
  withDeterministicId,
} from './events/flash-sale-events';

/**
 * `flash_sale.sold_out`, once per sale (S11 FR-022, R-08): when the last unit is claimed the buckets are read; if all
 * are empty a `SET NX` marker decides who emits, and the event is appended in its own transaction. When the append
 * fails the marker is deleted again so the next claim (or check) retries. Never throws: the buyer's order is done.
 */
@Injectable()
export class FlashSoldOutService {
  private readonly logger = new Logger(FlashSoldOutService.name);

  constructor(
    @Inject(FLASH_FAST_STORE) private readonly store: FlashFastStore,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  async check(sale: OpenSale): Promise<void> {
    try {
      const contents = await this.store.remaining(sale.saleId, sale.buckets);
      if (contents.some((c) => c > 0)) return;
      if (!(await this.store.markSoldOut(sale.saleId))) return;
      try {
        await this.runner.run(() =>
          this.outbox.append(
            withDeterministicId(
              FlashSaleSoldOut.create(sale.saleId, 0, {
                saleId: sale.saleId,
                shopId: sale.shopId,
                productId: sale.productId,
              }),
            ),
          ),
        );
      } catch (error) {
        await this.store.clearSoldOut(sale.saleId).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      this.logger.warn(
        `sold-out check of sale ${sale.saleId} failed: ${(error as Error).name}`,
      );
    }
  }
}
