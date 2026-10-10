import type { ShopRecord } from '../domain/ports';
import { ROLE_PERMISSIONS } from '../domain/permissions';
import type { ShopRole } from '../domain/shop-types';

/**
 * The shop as the API returns it (FR-004): explicit fields only, no payment-provider account and no internal column.
 * `myRole`/`myPermissions` are for display; the server decides on every request.
 */
export function toShopDto(shop: ShopRecord, role?: ShopRole) {
  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    plan: shop.plan,
    status: shop.status,
    verificationStatus: shop.verificationStatus,
    payoutsEnabled: shop.payoutsEnabled,
    region: shop.region,
    shopVersion: shop.shopVersion,
    createdAt: shop.createdAt.toISOString(),
    purgeAt: shop.purgeAt ? shop.purgeAt.toISOString() : null,
    ...(role && {
      myRole: role,
      myPermissions: [...ROLE_PERMISSIONS[role]],
    }),
  };
}
