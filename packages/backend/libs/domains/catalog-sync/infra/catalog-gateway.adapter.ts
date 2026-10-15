import { Injectable } from '@nestjs/common';
import {
  ProductImportService,
  ProductQueryService,
  ProductStockService,
  ShopNotActiveError,
  StockOperationConflictError,
} from '@app/domains/catalog';
import type {
  CatalogGateway,
  CatalogSource,
  CatalogUpsertItem,
  CatalogUpsertOutcome,
  LocalProduct,
  StockDeltaOp,
  StockDeltaOutcome,
} from '../domain/ports';

/** The only door to catalog: R1 services through the catalog barrel (no `Product` SQL, no product events). */
@Injectable()
export class CatalogServicesGateway implements CatalogGateway {
  constructor(
    private readonly imports: ProductImportService,
    private readonly stock: ProductStockService,
    private readonly products: ProductQueryService,
  ) {}

  async upsertItems(
    shopId: string,
    items: CatalogUpsertItem[],
    source: CatalogSource,
  ): Promise<CatalogUpsertOutcome> {
    try {
      const results = await this.imports.upsertFromExternal(
        shopId,
        items,
        source,
      );
      return { kind: 'ok', results };
    } catch (error) {
      if (error instanceof ShopNotActiveError)
        return { kind: 'shop_not_active', shopStatus: error.shopStatus };
      throw error;
    }
  }

  async applyStockDelta(ops: StockDeltaOp[]): Promise<StockDeltaOutcome> {
    try {
      const outcome = await this.stock.applyStockDelta(ops);
      return outcome.outcome === 'applied'
        ? { kind: 'applied', results: outcome.results }
        : { kind: 'rejected', failures: outcome.failures };
    } catch (error) {
      if (error instanceof StockOperationConflictError)
        return { kind: 'operation_conflict' };
      throw error;
    }
  }

  async getProducts(
    shopId: string,
    ids: string[],
  ): Promise<Map<string, LocalProduct>> {
    const found = await this.products.getProductsByIds(ids, { shopId });
    return new Map(
      [...found].map(([id, p]) => [
        id,
        {
          id: p.id,
          shopId: p.shopId,
          title: p.title,
          priceMinor: p.priceMinor,
          quantity: p.quantity,
          version: p.version,
          status: p.status,
          externalSku: p.externalSku,
        },
      ]),
    );
  }
}
