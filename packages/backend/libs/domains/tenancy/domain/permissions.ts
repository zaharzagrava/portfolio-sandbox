import { ShopRole } from '../infra/models/shop-membership.model';

/**
 * RBAC per membership (a user can be OWNER of one shop and VIEWER of another).
 * Permissions, not role names, are what endpoints require - adding a role
 * never means touching every controller.
 */
export const SHOP_PERMISSIONS = [
  'shop.read',
  'shop.manage',
  'shop.delete',
  'members.read',
  'members.manage',
  'products.read',
  'products.write',
  'orders.manage',
  'payouts.read',
  'billing.manage',
  'api-keys.manage',
  'webhooks.manage',
  'integrations.manage',
  'sso.manage',
] as const;

export type ShopPermission = (typeof SHOP_PERMISSIONS)[number];

const READ: ShopPermission[] = ['shop.read', 'members.read', 'products.read'];

export const ROLE_PERMISSIONS = {
  OWNER: [...SHOP_PERMISSIONS],
  ADMIN: SHOP_PERMISSIONS.filter(
    (p) => p !== 'shop.delete' && p !== 'billing.manage',
  ),
  STAFF: [...READ, 'products.write', 'orders.manage'],
  VIEWER: [...READ, 'payouts.read'],
} as const satisfies Record<ShopRole, readonly ShopPermission[]>;

export function can(role: ShopRole, permission: ShopPermission): boolean {
  return (ROLE_PERMISSIONS[role] as readonly ShopPermission[]).includes(
    permission,
  );
}
