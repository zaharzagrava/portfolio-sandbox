import type {
  PickupClusterCell,
  PickupNearItem,
  PickupOpeningHours,
  PickupPointNear,
} from '@marketplace-sandbox/contracts';
import type { CursorValue } from './search-cursor';
import type {
  OfferWrite,
  ProductCopyFacts,
  ShopCopyFacts,
} from './offer-document';

/**
 * Ports of the pickup capability (S19 D-6, A22): the application layer talks to these, the `infra/` adapters implement
 * them. Methods run inside the caller's transaction scope when there is one (the CLS of `TransactionRunner`), so none
 * takes a transaction argument. `now` is always supplied by the caller (FR-053).
 */

export interface PickupPointRecord {
  id: string;
  shopId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  openingHours: PickupOpeningHours;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PickupPointChanges {
  name?: string;
  address?: string;
  openingHours?: PickupOpeningHours;
  active?: boolean;
}

export interface PickupPointRepository {
  /** Serialises point creation of one shop until the transaction ends, then returns how many points it holds. */
  lockAndCount(shopId: string): Promise<number>;
  insert(
    shopId: string,
    input: {
      name: string;
      address: string;
      lat: number;
      lng: number;
      openingHours: PickupOpeningHours;
    },
    now: Date,
  ): Promise<PickupPointRecord>;
  /** The shop is in the predicate: another shop's point is `null`. */
  findInShop(
    shopId: string,
    pointId: string,
    options?: { forUpdate?: boolean },
  ): Promise<PickupPointRecord | null>;
  /** Projector read of the own table, by id. */
  findById(pointId: string): Promise<PickupPointRecord | null>;
  /** Applies the changes and adds one to `version`. */
  update(
    shopId: string,
    pointId: string,
    changes: PickupPointChanges,
    now: Date,
  ): Promise<PickupPointRecord>;
  /** Newest first (`createdAt desc, id desc`); `after` is the last `[createdAtIso, id]` of the previous page. */
  listPage(
    shopId: string,
    limit: number,
    after: [string, string] | null,
  ): Promise<PickupPointRecord[]>;
  /** Shop deletion: every active point becomes inactive with `version + 1`; returns the changed points. */
  deactivateAllOfShop(shopId: string, now: Date): Promise<PickupPointRecord[]>;
}

export interface PickupStockRecord {
  pickupPointId: string;
  productId: string;
  quantity: number;
  version: number;
  updatedAt: Date;
}

export interface PickupShortage {
  productId: string;
  requested: number;
  available: number;
}

export interface PickupStockRepository {
  /** The row locked for the rest of the transaction, or `null`. */
  lockRow(
    pickupPointId: string,
    productId: string,
  ): Promise<PickupStockRecord | null>;
  /** `null` when a concurrent insert won (the caller locks and decides again). */
  insert(
    pickupPointId: string,
    productId: string,
    quantity: number,
    now: Date,
  ): Promise<PickupStockRecord | null>;
  update(
    pickupPointId: string,
    productId: string,
    quantity: number,
    version: number,
    now: Date,
  ): Promise<PickupStockRecord>;
  find(
    pickupPointId: string,
    productId: string,
  ): Promise<PickupStockRecord | null>;
  /** Ordered by `productId`; `afterProductId` is the keyset position. */
  listOfPoint(
    pickupPointId: string,
    limit: number,
    afterProductId: string | null,
  ): Promise<PickupStockRecord[]>;
  listOfProduct(productId: string): Promise<PickupStockRecord[]>;
  /** Every stock row of a shop's points, keyset-paged by `[pickupPointId, productId]`. */
  listOfShop(
    shopId: string,
    limit: number,
    after: [string, string] | null,
  ): Promise<PickupStockRecord[]>;
  /** Removes every stock row of a product and returns what was removed. */
  deleteOfProduct(productId: string): Promise<PickupStockRecord[]>;
  /**
   * The exact check (R1) in one statement for the whole batch: whether the point is active and which lines it cannot
   * serve. `null`: no such point.
   */
  checkLines(
    pickupPointId: string,
    lines: { productId: string; quantity: number }[],
  ): Promise<{ active: boolean; shortages: PickupShortage[] } | null>;
}

export interface BrowseParams {
  lat: number;
  lng: number;
  radiusKm: number;
  productId?: string;
  limit: number;
  /** `[distanceM, id]` of the last item of the previous page. */
  after: [number, string] | null;
}

export interface PickupBrowseReader {
  /** Ordered by exact distance then id; returns up to `limit + 1` rows so the caller sees whether a page follows. */
  browse(
    params: BrowseParams,
  ): Promise<(PickupPointNear & { sortDistance: number })[]>;
}

export interface SearchParams {
  lat: number;
  lng: number;
  radiusKm: number;
  q?: string;
  limit: number;
  /** The sort tuple of the last item of the previous page. */
  after: CursorValue[] | null;
}

export interface SearchPage {
  /** At most `limit` items. */
  items: PickupNearItem[];
  /** The sort tuple to resume after, or `null` when there is nothing more. */
  next: CursorValue[] | null;
}

export interface ClusterParams {
  bbox: { top: number; left: number; bottom: number; right: number };
  zoom: number;
  productId?: string;
}

export interface PickupAvailabilityIndex {
  /** Creates the index mapping when missing; throws when the engine cannot be reached (readiness fails). */
  ensureIndex(): Promise<void>;
  /** Throws `SearchUnavailableError` on failure or over budget. */
  search(params: SearchParams): Promise<SearchPage>;
  /** Up to 501 cells so the caller can tell that it cut. */
  clusters(params: ClusterParams): Promise<{
    cells: PickupClusterCell[];
    omittedByEngine: boolean;
  }>;
  /** Versioned writes (index or delete). A version conflict counts as stale, not as a failure. */
  write(writes: OfferWrite[]): Promise<{ applied: number; stale: number }>;
}

export interface ProductCopyStore {
  /** Writes the copy only when its version is greater than the stored one; true when it wrote. */
  upsert(copy: ProductCopyFacts & { shopId: string }): Promise<boolean>;
  find(
    productId: string,
  ): Promise<(ProductCopyFacts & { shopId: string }) | null>;
  remove(productId: string): Promise<void>;
}

export interface ShopCopyStore {
  upsert(copy: ShopCopyFacts): Promise<boolean>;
  find(shopId: string): Promise<ShopCopyFacts | null>;
}

/** The catalog's batch read behind an anti-corruption layer (R1). `null`: not a product of this shop. */
export interface CatalogProductReader {
  findOwned(
    shopId: string,
    productId: string,
  ): Promise<(ProductCopyFacts & { shopId: string }) | null>;
}

export const PICKUP_POINT_REPOSITORY = Symbol('PICKUP_POINT_REPOSITORY');
export const PICKUP_STOCK_REPOSITORY = Symbol('PICKUP_STOCK_REPOSITORY');
export const PICKUP_BROWSE_READER = Symbol('PICKUP_BROWSE_READER');
export const PICKUP_AVAILABILITY_INDEX = Symbol('PICKUP_AVAILABILITY_INDEX');
export const PRODUCT_COPY_STORE = Symbol('PRODUCT_COPY_STORE');
export const SHOP_COPY_STORE = Symbol('SHOP_COPY_STORE');
export const CATALOG_PRODUCT_READER = Symbol('CATALOG_PRODUCT_READER');
