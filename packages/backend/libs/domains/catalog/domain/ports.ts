import type { ProductStatus } from './product-status';
import type { ProductRecord } from './product-view';
import type { CursorKey } from './product-cursor';
import type { ShopStateStatus } from './visibility';

/**
 * Ports of the catalog (I.1, D-6): `application/` depends on these interfaces and on the pure rules of `domain/`;
 * the Postgres adapters live in `infra/`. Every method joins the active transaction (CLS) when there is one.
 */

export interface NewProduct {
  id: string;
  shopId: string;
  createdBy: string | null;
  isSandbox: boolean;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  currency: string;
  quantity: number;
  tags: string[];
  now: Date;
}

/** The columns an update may change (AS-07); absent means unchanged. */
export type ProductChanges = Partial<
  Pick<
    NewProduct,
    | 'title'
    | 'description'
    | 'brand'
    | 'category'
    | 'priceMinor'
    | 'currency'
    | 'quantity'
    | 'tags'
  >
>;

export interface ProductListFilter {
  status: ProductStatus;
  category: string | null;
  inStock: boolean | null;
}

/** A listed row with the keyset position exactly as the database prints it. */
export interface ProductListRow {
  record: ProductRecord;
  key: CursorKey;
}

export interface ProductRepository
  extends
    ProductRepositoryStock,
    ProductRepositoryExternal,
    ProductRepositoryReads {
  /** `version` 1, `status` ACTIVE, `createdAt = updatedAt = now`. */
  insert(input: NewProduct): Promise<ProductRecord>;
  /** `WHERE id = :id AND "shopId" = :shopId`; another shop's product is simply absent (III.4). */
  findInShop(shopId: string, productId: string): Promise<ProductRecord | null>;
  /**
   * Conditional update (`… AND version = :expected`), `version + 1`; `null` when no row matched. An archived product
   * refuses it unless `anyStatus` (the external upsert keeps the status and still updates the fields).
   */
  update(
    shopId: string,
    productId: string,
    expectedVersion: number,
    changes: ProductChanges,
    now: Date,
    options?: { anyStatus?: boolean },
  ): Promise<ProductRecord | null>;
  /** Conditional transition (`… AND status = :from AND version = :expected`), `version + 1`; `null` when no row matched. */
  transition(
    shopId: string,
    productId: string,
    from: ProductStatus,
    to: ProductStatus,
    expectedVersion: number,
    now: Date,
  ): Promise<ProductRecord | null>;
  /**
   * The products among `ids` that are publicly visible (FR-013: `ACTIVE`, not sandbox, shop `ACTIVE` or without a
   * `ProductShopState` row), in ONE statement with a read deadline. Absent ids are simply not returned.
   */
  findVisibleByIds(ids: string[]): Promise<ProductRecord[]>;
  /** Keyset page: `"shopId"` first in the predicate, `ORDER BY "createdAt" DESC, "id" DESC`, `limit + 1` rows asked by the caller. */
  listByShop(
    shopId: string,
    filter: ProductListFilter,
    after: CursorKey | null,
    limit: number,
  ): Promise<ProductListRow[]>;
}

/** A product as an external system describes it (`upsertFromExternal`); `quantity` is optional on purpose. */
export interface ExternalProductFields {
  externalSku: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  currency: string;
  quantity?: number;
  tags: string[];
}

export interface ProductRepositoryStock {
  /** Locks the rows (`FOR UPDATE`, ordered by id) so a stock call decides on rows nobody else can change. */
  lockForStock(productIds: string[]): Promise<ProductRecord[]>;
  /** `quantity + delta`, `version + 1`, only when the result stays within `[0, 1e9]`; `null` when no row matched. */
  applyDelta(
    shopId: string,
    productId: string,
    delta: number,
    now: Date,
  ): Promise<ProductRecord | null>;
}

export interface ProductRepositoryExternal {
  /** The product of `(shopId, externalSku)`, locked for update. */
  lockByExternalSku(
    shopId: string,
    externalSku: string,
  ): Promise<ProductRecord | null>;
  /** `ON CONFLICT ("shopId","externalSku") DO NOTHING`: `null` means someone else inserted it first. */
  insertExternal(
    shopId: string,
    id: string,
    isSandbox: boolean,
    fields: ExternalProductFields,
    now: Date,
  ): Promise<ProductRecord | null>;
}

export interface ProductRepositoryReads {
  /** `WHERE id = ANY(ids) [AND "shopId" = :shopId]`, one statement, rows of any status. */
  findByIds(ids: string[], shopId?: string): Promise<ProductRecord[]>;
}

export interface StockOperationRecord {
  operationId: string;
  productId: string;
  shopId: string;
  delta: number;
  reason: string;
  quantityAfter: number;
  productVersion: number;
  appliedAt: Date;
}

export interface StockOperationRepository {
  findMany(operationIds: string[]): Promise<StockOperationRecord[]>;
  /** `ON CONFLICT ("operationId") DO NOTHING`: `false` when the id already exists. */
  insert(record: StockOperationRecord): Promise<boolean>;
  /** Deletes up to `limit` records applied before `cutoff`, oldest first; returns how many. */
  purgeOlderThan(cutoff: Date, limit: number): Promise<number>;
}

export interface ViewBatchRepository {
  /** Deletes the chunk markers applied before `cutoff`; returns how many. */
  purgeOlderThan(cutoff: Date): Promise<number>;
}

export interface StatusHistoryEntry {
  productId: string;
  shopId: string;
  fromStatus: ProductStatus;
  toStatus: ProductStatus;
  productVersion: number;
  actorId: string | null;
  at: Date;
}

export interface StatusHistoryRepository {
  append(entry: StatusHistoryEntry): Promise<void>;
}

export interface ShopStateRepository {
  find(shopId: string): Promise<{
    status: ShopStateStatus;
    shopVersion: number;
  } | null>;
}

export const PRODUCT_REPOSITORY = Symbol('PRODUCT_REPOSITORY');
export const STATUS_HISTORY_REPOSITORY = Symbol('STATUS_HISTORY_REPOSITORY');
export const SHOP_STATE_REPOSITORY = Symbol('SHOP_STATE_REPOSITORY');
export const STOCK_OPERATION_REPOSITORY = Symbol('STOCK_OPERATION_REPOSITORY');
export const VIEW_BATCH_REPOSITORY = Symbol('VIEW_BATCH_REPOSITORY');
