export const CATALOG_GATEWAY = Symbol('CATALOG_GATEWAY');

export type CatalogSource = 'shopify' | 'woocommerce';

/** One product for `upsertFromExternal`. `quantity` only for items with no link yet (S05 contract). */
export interface CatalogUpsertItem {
  externalSku: string;
  title: string;
  description?: string;
  brand: string;
  category: string;
  priceMinor: number;
  quantity?: number;
  tags?: string[];
}

export interface CatalogUpsertResult {
  externalSku: string;
  productId?: string;
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected';
  productVersion?: number;
  errors?: Array<{ field: string; code: string }>;
}

export type CatalogUpsertOutcome =
  | { kind: 'ok'; results: CatalogUpsertResult[] }
  /** `ShopNotActiveError` -> the run ends `skipped_shop_not_active`. */
  | { kind: 'shop_not_active'; shopStatus: string };

export interface StockDeltaOp {
  /** Deterministic: `sync:<integrationId>:<digest>`. */
  operationId: string;
  productId: string;
  shopId: string;
  delta: number;
  /** `sync-inbound` | `sync-deleted`. */
  reason: string;
}

export type StockDeltaOutcome =
  | {
      kind: 'applied';
      results: Array<{
        operationId: string;
        productId: string;
        quantityAfter: number;
        productVersion: number;
        replayed: boolean;
      }>;
    }
  | {
      kind: 'rejected';
      failures: Array<{
        operationId: string;
        productId: string;
        code:
          'insufficient_stock' | 'unavailable' | 'not_found' | 'quantity_limit';
      }>;
    }
  /** `StockOperationConflictError`: the operation id was used for a different change. */
  | { kind: 'operation_conflict' };

export interface LocalProduct {
  id: string;
  shopId: string;
  title: string;
  priceMinor: number;
  quantity: number;
  version: number;
  status: string;
  externalSku: string | null;
}

/** The only door to catalog (R1): no `Product` SQL, no `products.events` writes. */
export interface CatalogGateway {
  /** 1..500 items, outside any transaction. */
  upsertItems(
    shopId: string,
    items: CatalogUpsertItem[],
    source: CatalogSource,
  ): Promise<CatalogUpsertOutcome>;
  applyStockDelta(ops: StockDeltaOp[]): Promise<StockDeltaOutcome>;
  /** Reconciliation reads; <= 500 ids, only the given shop's products, from the database (not the cache). */
  getProducts(
    shopId: string,
    ids: string[],
  ): Promise<Map<string, LocalProduct>>;
}
