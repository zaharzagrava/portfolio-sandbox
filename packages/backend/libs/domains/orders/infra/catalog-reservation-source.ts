import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { ProductStockService } from '@app/domains/catalog';
import type { ReservationSource, StockOutcome } from '../domain/ports';
import type { StockOperationInput } from '../domain/stock-operations';
import { UpstreamUnavailableError } from '../domain/order-errors';
import { withTimeout } from './with-timeout';

/**
 * Stock held through the catalog's `applyStockDelta` (S05 R1): all-or-nothing, replay-safe per `operationId`. Maps the
 * catalog's failure codes: `insufficient_stock` is "out of stock"; an archived or unknown product is "unavailable".
 * Called outside any transaction of ours (no transaction spans two domains).
 */
@Injectable()
export class CatalogReservationSource implements ReservationSource {
  constructor(
    private readonly stock: ProductStockService,
    private readonly config: ApiConfigService,
  ) {}

  reserve(operations: StockOperationInput[]): Promise<StockOutcome> {
    return this.apply(operations);
  }

  release(operations: StockOperationInput[]): Promise<StockOutcome> {
    return this.apply(operations);
  }

  private async apply(
    operations: StockOperationInput[],
  ): Promise<StockOutcome> {
    const result = await withTimeout(
      this.stock.applyStockDelta(operations),
      this.config.get('orders_stock_timeout_ms'),
      () => new UpstreamUnavailableError('stock'),
    );
    if (result.outcome === 'applied') return { outcome: 'applied' };
    const insufficient = new Set<string>();
    const unavailable = new Set<string>();
    for (const f of result.failures)
      (f.code === 'insufficient_stock' ? insufficient : unavailable).add(
        f.productId,
      );
    return {
      outcome: 'rejected',
      insufficient: [...insufficient],
      unavailable: [...unavailable],
    };
  }
}
