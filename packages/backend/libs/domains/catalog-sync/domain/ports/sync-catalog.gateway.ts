import type { SyncChangeData, SyncField } from '@marketplace-sandbox/contracts';

export const SYNC_CATALOG_GATEWAY = Symbol('SYNC_CATALOG_GATEWAY');

export type CatalogStockFailure =
  'insufficient_stock' | 'unavailable' | 'not_found' | 'quantity_limit';

export interface SyncStockCommand {
  /** Deterministic: `sync:<shopId>:<opId>`, `…:clamp` for the second attempt of a clamped delta. */
  operationId: string;
  shopId: string;
  productId: string;
  delta: number;
  /** `sync.received|sold|damaged|returned|other` (the count reason is `sync.other`). */
  reason: string;
}

export type SyncStockOutcome =
  | {
      kind: 'applied';
      quantityAfter: number;
      productVersion: number;
      replayed: boolean;
    }
  | { kind: 'rejected'; code: CatalogStockFailure };

export interface SyncProductView {
  id: string;
  version: number;
  quantity: number;
  status: 'ACTIVE' | 'ARCHIVED';
  data: SyncChangeData;
}

export type SyncUpdateOutcome =
  | { kind: 'updated'; version: number }
  | { kind: 'version_conflict' }
  /** The catalog refused the values; the fields it names. */
  | { kind: 'invalid'; fields: SyncField[] }
  | { kind: 'archived' }
  | { kind: 'not_found' };

export interface SyncProductPage {
  items: SyncProductView[];
  nextCursor: string | null;
}

/** The catalog's exported services behind one port (R1): the only way this capability reaches a product. */
export interface SyncCatalogGateway {
  applyStock(command: SyncStockCommand): Promise<SyncStockOutcome>;
  /** Unknown and foreign products are both `null`. */
  product(shopId: string, productId: string): Promise<SyncProductView | null>;
  updateFields(
    shopId: string,
    productId: string,
    expectedVersion: number,
    fields: Partial<Record<SyncField, string | number>>,
    actorId: string | null,
  ): Promise<SyncUpdateOutcome>;
  /** The shop's products by keyset, for rebuilding its feed. */
  listProducts(shopId: string, cursor: string | null): Promise<SyncProductPage>;
}
