import {
  SHOP_PERMISSIONS,
  type ShopPermission,
  type ShopRole,
} from './shop-types';

export { SHOP_PERMISSIONS };
export type { ShopPermission };

/**
 * RBAC per membership (a user can be OWNER of one shop and VIEWER of another). Permissions, not role names, are what
 * endpoints require - adding a role never means touching every controller. The matrix is FR-020.
 */
const READ: ShopPermission[] = [
  'shop.read',
  'members.read',
  'products.read',
  'orders.read',
];
const STAFF: ShopPermission[] = [...READ, 'products.write', 'orders.manage'];
const ADMIN: ShopPermission[] = [
  ...STAFF,
  'shop.manage',
  'members.manage',
  'payouts.read',
  'api-keys.manage',
  'webhooks.manage',
  'integrations.manage',
];

export const ROLE_PERMISSIONS = {
  OWNER: [...SHOP_PERMISSIONS],
  ADMIN,
  STAFF,
  VIEWER: READ,
} as const satisfies Record<ShopRole, readonly ShopPermission[]>;

/** Always read from the database, never from the authorization cache (FR-015). */
export const SENSITIVE_PERMISSIONS: readonly ShopPermission[] = [
  'members.manage',
  'sso.manage',
  'shop.delete',
  'shop.manage',
  'shop.export',
  'billing.manage',
  'payouts.read',
  'api-keys.manage',
  'webhooks.manage',
];

export function can(role: ShopRole, permission: ShopPermission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly ShopPermission[]).includes(
    permission,
  );
}
