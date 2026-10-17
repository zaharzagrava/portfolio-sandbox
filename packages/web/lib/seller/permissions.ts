/**
 * What a member may see and do in a shop (W04 FR-008, FR-011, FR-012). Presentation only: the API decides on every call
 * (VI.5) and a refusal is always handled. The decision reads `myPermissions` of the shop answer, never the role claim.
 */

/** The permission names of S03 FR-020 (`GET /shop-roles`). The contract package types them as plain strings. */
export const SHOP_PERMISSIONS = [
  'shop.read',
  'shop.manage',
  'shop.delete',
  'shop.export',
  'members.read',
  'members.manage',
  'products.read',
  'products.write',
  'orders.read',
  'orders.manage',
  'payouts.read',
  'billing.manage',
  'api-keys.manage',
  'webhooks.manage',
  'integrations.manage',
  'widget.manage',
  'sso.manage',
] as const;
export type ShopPermission = (typeof SHOP_PERMISSIONS)[number];

type WithPermissions = { myPermissions?: readonly string[] | null; myRole?: string };

/** `true` only when the shop answer lists the permission; a shop without `myPermissions` grants nothing. */
export function shopCan(shop: WithPermissions | null | undefined, permission: ShopPermission): boolean {
  return shop?.myPermissions?.includes(permission) ?? false;
}

export const shopPages = ['overview', 'inventory', 'orders', 'team', 'team-invitations', 'api-keys', 'api-version', 'webhooks', 'logs', 'usage', 'payouts', 'statements', 'imports', 'exports','campaigns', 'widget', 'knowledge', 'integrations'] as const;
export type ShopPage = (typeof shopPages)[number];

/** Page to the permission it needs (spec "Screens and routes"). Overview needs membership, which `shop.read` stands for. */
export const pageRequires: Record<ShopPage, ShopPermission> = {
  overview: 'shop.read',
  inventory: 'products.read',
  orders: 'orders.read',
  team: 'members.read',
  'team-invitations': 'members.manage',
  'api-keys': 'shop.manage',
  'api-version': 'shop.manage',
  webhooks: 'webhooks.manage',
  logs: 'shop.read',
  usage: 'shop.read',
  payouts: 'payouts.read',
  statements: 'payouts.read',
  imports: 'products.write',
  exports: 'orders.manage',
  integrations: 'integrations.manage',
  campaigns: 'products.read',
  widget: 'widget.manage',
  knowledge: 'products.read',
};

export const SUSPENDED_COPY = 'This shop is suspended. You can view data but not make changes.';
export const CLOSING_COPY = 'This shop is being closed. You can view data but not make changes.';

/** Write controls are disabled (with `reason` as their description) unless the shop is `ACTIVE` (AS-86). */
export function shopWritable(shop: { status: string } | null | undefined): { writable: boolean; reason: string | null } {
  if (!shop) return { writable: false, reason: 'This shop is not available.' };
  if (shop.status === 'ACTIVE') return { writable: true, reason: null };
  return { writable: false, reason: shop.status === 'SUSPENDED' ? SUSPENDED_COPY : CLOSING_COPY };
}

/** Same as `shopWritable`, named as a hook for components; it keeps no state. */
export function useShopWritable(shop: { status: string } | null | undefined): { writable: boolean; reason: string | null } {
  return shopWritable(shop);
}
