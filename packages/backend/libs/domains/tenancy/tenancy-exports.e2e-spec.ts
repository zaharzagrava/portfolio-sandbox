import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import * as barrel from './index';
import { AUTHZ_CACHE, type AuthzCache } from './domain/ports';
import { ShopAccessService } from './application/shop-access.service';
import { MembershipQueryService } from './application/membership-query.service';
import { ShopQueryService } from './application/shop-query.service';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

describe('Exported services of the tenancy domain', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let access: ShopAccessService;
  let shops: ShopQueryService;
  let members: MembershipQueryService;
  let cache: AuthzCache;

  /** Statements that touch the given table, as a spec counts "one query". */
  const counting = async <T>(table: string, fn: () => Promise<T>) => {
    const seen: string[] = [];
    const hook = (_: unknown, query: { sql?: string } | undefined) => {
      const sql = typeof query === 'object' ? (query?.sql ?? '') : '';
      if (new RegExp(`"${table}"`).test(sql) && /^\s*(SELECT|WITH)/i.test(sql))
        seen.push(sql);
    };
    sequelize.addHook('afterQuery', 'tenancy-count', hook as never);
    try {
      return { result: await fn(), queries: seen };
    } finally {
      sequelize.removeHook('afterQuery', 'tenancy-count');
    }
  };

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
    access = t.app.get(ShopAccessService);
    shops = t.app.get(ShopQueryService);
    members = t.app.get(MembershipQueryService);
    cache = t.app.get(AUTHZ_CACHE);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('S03 AS-74: ShopAccessService.assertMember', () => {
    it('returns the role of a member holding the permission', async () => {
      const owner = await t.newUser();
      const viewer = await t.newUser();
      const shop = await createShop(t.app, owner);
      await addMember(t.app, shop.id, viewer.id, 'VIEWER');
      await expect(
        access.assertMember(shop.id, owner.id, 'shop.delete'),
      ).resolves.toEqual({ role: 'OWNER' });
      await expect(access.assertMember(shop.id, viewer.id)).resolves.toEqual({
        role: 'VIEWER',
      });
      await expect(access.getRole(shop.id, viewer.id)).resolves.toBe('VIEWER');
    });

    it('answers not-found for a non-member, an unknown, a malformed and a deleted shop, and forbidden for a missing permission', async () => {
      const owner = await t.newUser();
      const stranger = await t.newUser();
      const viewer = await t.newUser();
      const shop = await createShop(t.app, owner);
      const deleted = await createShop(t.app, owner, { status: 'DELETED' });
      await addMember(t.app, shop.id, viewer.id, 'VIEWER');
      for (const shopId of [shop.id, uuidv7(), 'not-a-uuid', deleted.id])
        await expect(
          access.assertMember(shopId, stranger.id, 'shop.read'),
        ).rejects.toMatchObject({ code: 'shop_not_found' });
      await expect(
        access.assertMember(deleted.id, owner.id),
      ).rejects.toMatchObject({ code: 'shop_not_found' });
      await expect(access.getRole(deleted.id, owner.id)).resolves.toBeNull();
      await expect(
        access.assertMember(shop.id, viewer.id, 'products.write'),
      ).rejects.toMatchObject({ code: 'permission_denied' });
    });

    it('applies the status gate and reads sensitive permissions from the database', async () => {
      const owner = await t.newUser();
      const removed = await t.newUser();
      const suspended = await createShop(t.app, owner, { status: 'SUSPENDED' });
      await expect(
        access.assertMember(suspended.id, owner.id, 'shop.read'),
      ).resolves.toEqual({ role: 'OWNER' });
      await expect(
        access.assertMember(suspended.id, owner.id, 'products.write'),
      ).rejects.toMatchObject({ code: 'shop_suspended' });
      const closing = await createShop(t.app, owner, { status: 'DELETING' });
      await expect(
        access.assertMember(closing.id, owner.id, 'shop.delete'),
      ).resolves.toEqual({ role: 'OWNER' });
      await expect(
        access.assertMember(closing.id, owner.id, 'shop.manage'),
      ).rejects.toMatchObject({ code: 'shop_offboarding' });

      const shop = await createShop(t.app, owner);
      await cache.set(shop.id, removed.id, { role: 'ADMIN', status: 'ACTIVE' }); // stale entry of someone not a member
      await expect(
        access.assertMember(shop.id, removed.id, 'products.read'),
      ).resolves.toEqual({ role: 'ADMIN' });
      await expect(
        access.assertMember(shop.id, removed.id, 'members.manage'),
      ).rejects.toMatchObject({ code: 'shop_not_found' });
    });
  });

  describe('S03 AS-75: ShopQueryService.getShopsByIds', () => {
    it('returns summaries in one query, collapsing duplicates, omitting unknown ids and including closed shops', async () => {
      const owner = await t.newUser();
      const live = await createShop(t.app, owner, {
        slug: 'q-live',
        plan: 'PRO',
        region: 'us-east-1',
      });
      const suspended = await createShop(t.app, owner, {
        slug: 'q-susp',
        status: 'SUSPENDED',
      });
      const gone = await createShop(t.app, owner, {
        slug: 'deleted-x',
        status: 'DELETED',
      });
      const sandbox = await createShop(t.app, null, {
        slug: 'q-live-sandbox',
        sandboxOf: live.id,
      });

      const { result, queries } = await counting('Shop', () =>
        shops.getShopsByIds([
          live.id,
          suspended.id,
          live.id,
          gone.id,
          sandbox.id,
          uuidv7(),
        ]),
      );
      expect(queries).toHaveLength(1);
      expect([...result.keys()].sort()).toEqual(
        [live.id, suspended.id, gone.id, sandbox.id].sort(),
      );
      expect(result.get(live.id)).toEqual({
        id: live.id,
        slug: 'q-live',
        name: live.name,
        plan: 'PRO',
        status: 'ACTIVE',
        verificationStatus: 'UNVERIFIED',
        payoutsEnabled: false,
        region: 'us-east-1',
        isSandbox: false,
        sandboxOf: null,
        shopVersion: 1,
      });
      expect(result.get(suspended.id)!.status).toBe('SUSPENDED');
      expect(result.get(gone.id)!.status).toBe('DELETED');
      expect(result.get(sandbox.id)).toMatchObject({
        isSandbox: true,
        sandboxOf: live.id,
      });
      expect(JSON.stringify([...result.values()])).not.toMatch(/stripe/i);
    });

    it('accepts 500 ids and refuses 501', async () => {
      const ids = Array.from({ length: 501 }, () => uuidv7());
      await expect(
        shops.getShopsByIds(ids.slice(0, 500)),
      ).resolves.toBeInstanceOf(Map);
      await expect(shops.getShopsByIds(ids)).rejects.toMatchObject({
        code: 'validation_failed',
      });
      await expect(shops.getShopsByIds([])).resolves.toEqual(new Map());
    });
  });

  describe('S03 AS-76: MembershipQueryService.getMembersByShopIds', () => {
    it('returns the members of many shops in one query, ordered by shop, join time and user, optionally by role', async () => {
      const [a, b, c] = await Promise.all([
        t.newUser(),
        t.newUser(),
        t.newUser(),
      ]);
      const s1 = await createShop(t.app, a);
      const s2 = await createShop(t.app, b);
      await addMember(
        t.app,
        s1.id,
        b.id,
        'ADMIN',
        'invite',
        new Date(Date.UTC(2030, 0, 1)),
      );
      await addMember(
        t.app,
        s1.id,
        c.id,
        'VIEWER',
        'invite',
        new Date(Date.UTC(2030, 0, 2)),
      );
      await addMember(
        t.app,
        s2.id,
        c.id,
        'OWNER',
        'invite',
        new Date(Date.UTC(2030, 0, 3)),
      );

      const all = await counting('ShopMembership', () =>
        members.getMembersByShopIds([s1.id, s2.id, s1.id, uuidv7()]),
      );
      expect(all.queries).toHaveLength(1);
      expect(all.result.get(s1.id)).toEqual([
        { userId: a.id, role: 'OWNER' },
        { userId: b.id, role: 'ADMIN' },
        { userId: c.id, role: 'VIEWER' },
      ]);
      expect(all.result.get(s2.id)).toEqual([
        { userId: b.id, role: 'OWNER' },
        { userId: c.id, role: 'OWNER' },
      ]);
      const owners = await counting('ShopMembership', () =>
        members.getMembersByShopIds([s1.id, s2.id], ['OWNER']),
      );
      expect(owners.queries).toHaveLength(1);
      expect(owners.result.get(s1.id)).toEqual([
        { userId: a.id, role: 'OWNER' },
      ]);
      await expect(
        members.getMembersByShopIds(
          Array.from({ length: 501 }, () => uuidv7()),
        ),
      ).rejects.toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('S03 AS-77: the barrel', () => {
    it('exports the module, the decorator, the R1 services and the event contracts', () => {
      for (const name of [
        'TenancyModule',
        'TenancyWorkerModule',
        'ShopScoped',
        'ShopAccessService',
        'ShopQueryService',
        'MembershipQueryService',
        'ShopProvisioningService',
        'TenantConnectionResolver',
        'ShopTransactionRunner',
        'ShopBatchReadModule',
        'ShopTopicsModule',
        'ShopCreated',
        'MemberAdded',
        'MemberRemoved',
        'MemberRoleChanged',
      ])
        expect(Object.keys(barrel)).toContain(name);
    });

    it('exports no model beyond the transitional ones, and that list may only shrink', () => {
      const models = Object.keys(barrel)
        .filter((n) => /Model$/.test(n))
        .sort();
      // Transitional (plan Risk 1): their consumers are other capabilities' pull requests. Remove names as they migrate.
      expect(models).toEqual([
        'ShopDirectoryModel',
        'ShopInviteModel',
        'ShopMembershipModel',
        'ShopModel',
        'ShopSsoConfigModel',
      ]);
    });
  });
});
