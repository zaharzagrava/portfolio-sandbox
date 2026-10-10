import fc from 'fast-check';
import {
  can,
  ROLE_PERMISSIONS,
  SHOP_PERMISSIONS,
  SENSITIVE_PERMISSIONS,
} from './permissions';
import type { ShopPermission } from './shop-types';
import { SHOP_ROLES } from './shop-types';

const ALL_ROLES = ['OWNER', 'ADMIN', 'STAFF', 'VIEWER'] as const;
const ROLES_FROM = {
  VIEWER: ['VIEWER', 'STAFF', 'ADMIN', 'OWNER'],
  STAFF: ['STAFF', 'ADMIN', 'OWNER'],
  ADMIN: ['ADMIN', 'OWNER'],
  OWNER: ['OWNER'],
} as const;

/** The FR-020 matrix: the lowest role that holds each permission. */
const LOWEST_ROLE: Record<ShopPermission, keyof typeof ROLES_FROM> = {
  'shop.read': 'VIEWER',
  'members.read': 'VIEWER',
  'products.read': 'VIEWER',
  'orders.read': 'VIEWER',
  'products.write': 'STAFF',
  'orders.manage': 'STAFF',
  'shop.manage': 'ADMIN',
  'members.manage': 'ADMIN',
  'payouts.read': 'ADMIN',
  'api-keys.manage': 'ADMIN',
  'webhooks.manage': 'ADMIN',
  'integrations.manage': 'ADMIN',
  'shop.delete': 'OWNER',
  'shop.export': 'OWNER',
  'billing.manage': 'OWNER',
  'sso.manage': 'OWNER',
};

const CASES = ALL_ROLES.flatMap((role) =>
  (Object.keys(LOWEST_ROLE) as ShopPermission[]).map(
    (permission) =>
      [
        role,
        permission,
        (ROLES_FROM[LOWEST_ROLE[permission]] as readonly string[]).includes(
          role,
        ),
      ] as const,
  ),
);

describe('S03 AS-16 permission matrix', () => {
  it('lists exactly the permissions of the matrix', () => {
    expect([...SHOP_PERMISSIONS].sort()).toEqual(
      Object.keys(LOWEST_ROLE).sort(),
    );
  });

  it.each(CASES)('%s %s -> %s', (role, permission, expected) => {
    expect(can(role, permission)).toBe(expected);
  });

  it('VIEWER has no payouts.read and ADMIN has no sso.manage', () => {
    expect(can('VIEWER', 'payouts.read')).toBe(false);
    expect(can('ADMIN', 'sso.manage')).toBe(false);
  });

  it('the sensitive set is the FR-015 list', () => {
    for (const p of SENSITIVE_PERMISSIONS)
      expect(SHOP_PERMISSIONS).toContain(p);
    expect([...SENSITIVE_PERMISSIONS].sort()).toEqual(
      [
        'members.manage',
        'sso.manage',
        'shop.delete',
        'shop.manage',
        'shop.export',
        'billing.manage',
        'payouts.read',
        'api-keys.manage',
        'webhooks.manage',
      ].sort(),
    );
  });
});

describe('S03 AS-17 role monotonicity', () => {
  it('OWNER ⊇ ADMIN ⊇ STAFF ⊇ VIEWER for any permission', () => {
    const permission = fc.constantFrom(...SHOP_PERMISSIONS);
    fc.assert(
      fc.property(permission, (p) => {
        const chain = [...SHOP_ROLES].reverse(); // VIEWER, STAFF, ADMIN, OWNER
        for (let i = 0; i < chain.length - 1; i++)
          if (can(chain[i], p)) expect(can(chain[i + 1], p)).toBe(true);
      }),
    );
  });

  it('permission lists are subsets going up', () => {
    const set = (r: (typeof ALL_ROLES)[number]) =>
      new Set<string>(ROLE_PERMISSIONS[r]);
    for (const [low, high] of [
      ['VIEWER', 'STAFF'],
      ['STAFF', 'ADMIN'],
      ['ADMIN', 'OWNER'],
    ] as const)
      for (const p of set(low)) expect(set(high).has(p)).toBe(true);
  });
});
