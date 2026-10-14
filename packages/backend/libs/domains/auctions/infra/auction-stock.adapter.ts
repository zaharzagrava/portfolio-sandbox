import { Injectable } from '@nestjs/common';
import { ProductStockService } from '@app/domains/catalog';
import type { AuctionStockPort, StockResult } from '../domain/auction-ports';
import { UpstreamUnavailableError } from '../domain/auction-errors';
import { withTimeout } from '../domain/with-timeout';

const STOCK_TIMEOUT_MS = 2000;

/**
 * The auctioned unit leaves and returns through the catalog's `applyStockDelta` (S05 R1, S21 FR-010): operation
 * `auctions:<id>:hold` (−1) and `auctions:<id>:return` (+1, a new operation, not a compensation). Idempotent per
 * operation ID, so a retry after a lost answer applies nothing twice. Called outside any transaction of ours.
 */
@Injectable()
export class AuctionStockAdapter implements AuctionStockPort {
  constructor(private readonly stock: ProductStockService) {}

  hold(
    auctionId: string,
    productId: string,
    shopId: string,
  ): Promise<StockResult> {
    return this.apply(
      `auctions:${auctionId}:hold`,
      productId,
      shopId,
      -1,
      'auction.hold',
    );
  }

  return(
    auctionId: string,
    productId: string,
    shopId: string,
  ): Promise<StockResult> {
    return this.apply(
      `auctions:${auctionId}:return`,
      productId,
      shopId,
      1,
      'auction.return',
    );
  }

  private async apply(
    operationId: string,
    productId: string,
    shopId: string,
    delta: -1 | 1,
    reason: string,
  ): Promise<StockResult> {
    const result = await withTimeout(
      this.stock.applyStockDelta([
        { operationId, productId, shopId, delta, reason },
      ]),
      STOCK_TIMEOUT_MS,
      () => new UpstreamUnavailableError('stock'),
    );
    if (result.outcome === 'applied')
      return {
        ok: true,
        replayed: result.results.every((r) => r.replayed),
      };
    const insufficient = result.failures.some(
      (f) => f.code === 'insufficient_stock',
    );
    return {
      ok: false,
      reason: insufficient ? 'insufficient_stock' : 'unavailable',
    };
  }
}
