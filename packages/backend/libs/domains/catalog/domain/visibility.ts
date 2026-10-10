import type { ProductStatus } from './product-status';

export type ShopStateStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';

/**
 * Public visibility (FR-013), the pure twin of the SQL predicate in the repository:
 * `status = 'ACTIVE' AND NOT isSandbox AND COALESCE(shopState.status, 'ACTIVE') = 'ACTIVE'`.
 * No `ProductShopState` row (`null`) means the shop is active.
 */
export const isPubliclyVisible = (
  product: { status: ProductStatus; isSandbox: boolean },
  shopState: ShopStateStatus | null,
): boolean =>
  product.status === 'ACTIVE' &&
  !product.isSandbox &&
  (shopState ?? 'ACTIVE') === 'ACTIVE';
