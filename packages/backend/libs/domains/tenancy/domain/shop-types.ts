/** Roles, highest first. Pure types: nothing in `domain/` imports from `infra/` (I.2). */
export const SHOP_ROLES = ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const;
export type ShopRole = (typeof SHOP_ROLES)[number];

export const SHOP_PLANS = ['STARTER', 'PRO', 'ENTERPRISE'] as const;
export type ShopPlan = (typeof SHOP_PLANS)[number];

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
  'sso.manage',
] as const;
export type ShopPermission = (typeof SHOP_PERMISSIONS)[number];

export type MemberSource = 'owner' | 'invite' | 'sso' | 'provisioned';
export type ShopId = string;
export type UserId = string;
