import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pageRequires, shopCan, shopPages, useShopWritable, type ShopPermission } from './permissions';

/** S03 FR-020 matrix as `GET /shop-roles` returns it. */
const READ: ShopPermission[] = ['shop.read', 'members.read', 'products.read', 'orders.read'];
const STAFF: ShopPermission[] = [...READ, 'products.write', 'orders.manage'];
const ADMIN: ShopPermission[] = [...STAFF, 'shop.manage', 'members.manage', 'payouts.read', 'api-keys.manage', 'webhooks.manage', 'integrations.manage', 'widget.manage'];
const OWNER: ShopPermission[] = [...ADMIN, 'shop.delete', 'shop.export', 'billing.manage', 'sso.manage'];
const ROLES = { OWNER, ADMIN, STAFF, VIEWER: READ } as const;
const ALL: ShopPermission[] = OWNER;

describe('W04 shopCan', () => {
  describe.each(Object.entries(ROLES))('W04 AS-42: role %s', (role, permissions) => {
    const shop = { myRole: role, myPermissions: permissions };
    it.each(ALL)('decides %s from myPermissions', (permission) => {
      expect(shopCan(shop, permission)).toBe(permissions.includes(permission));
    });
  });

  it('W04 AS-42: viewers read and staff write products', () => {
    expect(shopCan({ myPermissions: READ }, 'products.write')).toBe(false);
    expect(shopCan({ myPermissions: STAFF }, 'products.write')).toBe(true);
  });

  it('W04 AS-42: a missing or null myPermissions is no permission at all, and the role claim is never read', () => {
    expect(shopCan({}, 'shop.read')).toBe(false);
    expect(shopCan({ myRole: 'OWNER' }, 'shop.read')).toBe(false);
    expect(shopCan(null, 'shop.read')).toBe(false);
    expect(shopCan(undefined, 'shop.read')).toBe(false);
  });
});

describe('W04 pageRequires', () => {
  it('W04 AS-54: keys and version need shop.manage, webhooks webhooks.manage, logs and usage shop.read, orders orders.read', () => {
    expect(pageRequires).toMatchObject({
      inventory: 'products.read',
      orders: 'orders.read',
      team: 'members.read',
      'team-invitations': 'members.manage',
      'api-keys': 'shop.manage',
      'api-version': 'shop.manage',
      webhooks: 'webhooks.manage',
      logs: 'shop.read',
      usage: 'shop.read',
    });
  });

  it('W04 AS-54: every page has a permission and the overview needs none beyond membership', () => {
    for (const page of shopPages) expect(pageRequires[page], page).toBeDefined();
    expect(pageRequires.overview).toBe('shop.read');
  });

  it.each([
    ['VIEWER', ['overview', 'inventory', 'orders', 'team', 'logs', 'usage', 'campaigns', 'knowledge']],
    ['STAFF', ['overview', 'inventory', 'orders', 'team', 'logs', 'usage', 'imports', 'exports', 'campaigns', 'knowledge']],
    ['ADMIN', [...shopPages]],
    ['OWNER', [...shopPages]],
  ] as const)('W04 AS-54: %s may open exactly these pages', (role, pages) => {
    const shop = { myPermissions: ROLES[role] };
    expect(shopPages.filter((page) => shopCan(shop, pageRequires[page]))).toEqual([...pages]);
  });
});

describe('W04 useShopWritable', () => {
  it.each([
    ['ACTIVE', true, null],
    ['SUSPENDED', false, 'This shop is suspended. You can view data but not make changes.'],
    ['DELETING', false, 'This shop is being closed. You can view data but not make changes.'],
  ] as const)('W04 AS-86: %s gives writable=%s', (status, writable, reason) => {
    const { result } = renderHook(() => useShopWritable({ status }));
    expect(result.current).toEqual({ writable, reason });
  });

  it('W04 AS-86: an unknown shop is not writable', () => {
    const { result } = renderHook(() => useShopWritable(undefined));
    expect(result.current.writable).toBe(false);
  });
});
