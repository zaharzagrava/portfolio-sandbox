import type {
  ProductBatchItem,
  ProductMemberView,
  ProductPublicView,
  ProductSnapshot,
  ProductStatus,
} from '@marketplace-sandbox/contracts';

/**
 * What the repositories hand to the services: one product row with its types fixed (counts as numbers, dates as
 * `Date`). Internal to the domain; `createdBy` and `isSandbox` never reach the HTTP views.
 */
export interface ProductRecord {
  id: string;
  shopId: string;
  createdBy: string | null;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  currency: string;
  rating: number;
  tags: string[];
  quantity: number;
  status: ProductStatus;
  isSandbox: boolean;
  externalSku: string | null;
  version: number;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** R1 view (`ProductQueryService`): what other capabilities may know about a product. */
export interface ProductDto {
  id: string;
  shopId: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  currency: string;
  rating: number;
  tags: string[];
  quantity: number;
  inStock: boolean;
  status: ProductStatus;
  isSandbox: boolean;
  externalSku: string | null;
  version: number;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export const toProductDto = (p: ProductRecord): ProductDto => ({
  id: p.id,
  shopId: p.shopId,
  title: p.title,
  description: p.description,
  brand: p.brand,
  category: p.category,
  priceMinor: p.priceMinor,
  currency: p.currency,
  rating: p.rating,
  tags: p.tags,
  quantity: p.quantity,
  inStock: p.quantity > 0,
  status: p.status,
  isSandbox: p.isSandbox,
  externalSku: p.externalSku,
  version: p.version,
  viewCount: p.viewCount,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** Member view: shop members see the exact stock, the status and the external SKU. */
export const toMemberView = (p: ProductRecord): ProductMemberView => ({
  id: p.id,
  shopId: p.shopId,
  title: p.title,
  description: p.description,
  brand: p.brand,
  category: p.category,
  priceMinor: p.priceMinor,
  currency: p.currency,
  rating: p.rating,
  tags: p.tags,
  quantity: p.quantity,
  inStock: p.quantity > 0,
  status: p.status,
  version: p.version,
  viewCount: p.viewCount,
  externalSku: p.externalSku,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

/** Public view: no `sellerId`, no exact `quantity`, no status; `id` and `version` feed the ETag. */
export const toPublicView = (p: ProductRecord): ProductPublicView => ({
  id: p.id,
  shopId: p.shopId,
  title: p.title,
  description: p.description,
  brand: p.brand,
  category: p.category,
  priceMinor: p.priceMinor,
  currency: p.currency,
  rating: p.rating,
  tags: p.tags,
  inStock: p.quantity > 0,
  version: p.version,
  viewCount: p.viewCount,
  updatedAt: p.updatedAt.toISOString(),
});

export const toBatchItem = (p: ProductRecord): ProductBatchItem => ({
  id: p.id,
  shopId: p.shopId,
  title: p.title,
  priceMinor: p.priceMinor,
  currency: p.currency,
  inStock: p.quantity > 0,
  category: p.category,
  rating: p.rating,
});

/** Full-state event payload: never view counts, `createdBy` or embeddings. */
export const toSnapshot = (
  p: ProductRecord,
  changedFields: ProductSnapshot['changedFields'],
): ProductSnapshot => ({
  productId: p.id,
  shopId: p.shopId,
  title: p.title,
  description: p.description,
  brand: p.brand,
  category: p.category,
  priceMinor: p.priceMinor,
  currency: p.currency,
  rating: p.rating,
  tags: p.tags,
  quantity: p.quantity,
  inStock: p.quantity > 0,
  status: p.status,
  isSandbox: p.isSandbox,
  externalSku: p.externalSku,
  productVersion: p.version,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  changedFields,
});

/** The batch item of an already-built public view (the cache holds public views, not rows). */
export const batchItemOf = (v: ProductPublicView): ProductBatchItem => ({
  id: v.id,
  shopId: v.shopId,
  title: v.title,
  priceMinor: v.priceMinor,
  currency: v.currency,
  inStock: v.inStock,
  category: v.category,
  rating: v.rating,
});
