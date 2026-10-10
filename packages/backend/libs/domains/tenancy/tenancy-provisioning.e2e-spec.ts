import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { Role } from '@app/domains/identity';
import { ShopProvisioningService } from './application/shop-provisioning.service';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

describe('Shop provisioning for other capabilities', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let provisioning: ShopProvisioningService;

  const sql = <R extends object>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<R>(query, { type: QueryTypes.SELECT, replacements });
  const sellers = (n: number) =>
    Promise.all(
      Array.from({ length: n }, () => t.newUser({ role: Role.SELLER })),
    );
  const count = async (table: string) =>
    Number(
      (await sql<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`))[0].n,
    );
  const eventCount = async () =>
    Number(
      (await sql<{ n: string }>(`SELECT count(*) AS n FROM "Outbox"`))[0].n,
    );

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
    provisioning = t.app.get(ShopProvisioningService);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('S03 AS-62: legacy sellers', () => {
    it('gives each distinct seller one shop, one owner membership, one directory row and one event, and returns the map', async () => {
      const [u1, u2] = await sellers(2);
      const map = await provisioning.ensureShopsForLegacySellers([
        u1.id,
        u2.id,
        u1.id,
      ]);
      expect([...map.keys()].sort()).toEqual([u1.id, u2.id].sort());

      for (const u of [u1, u2]) {
        const shopId = map.get(u.id)!;
        const [shop] = await sql<{ slug: string; sandboxOf: string | null }>(
          `SELECT "slug","sandboxOf" FROM "Shop" WHERE "id" = :id`,
          { id: shopId },
        );
        expect(shop).toEqual({ slug: `seller-${u.id}`, sandboxOf: null });
        expect(
          await sql(
            `SELECT "userId","role","source" FROM "ShopMembership" WHERE "shopId" = :id`,
            { id: shopId },
          ),
        ).toEqual([{ userId: u.id, role: 'OWNER', source: 'provisioned' }]);
        expect(
          await sql(`SELECT "cell" FROM "ShopDirectory" WHERE "shopId" = :id`, {
            id: shopId,
          }),
        ).toEqual([{ cell: 'pooled' }]);
        const created = (await outboxRowsFor(t.app, shopId)).filter(
          (e) => e.type === 'tenancy.shop_created',
        );
        expect(created).toHaveLength(1);
        expect(created[0].payload).toMatchObject({
          payload: { shopId, ownerId: u.id, slug: `seller-${u.id}` },
        });
      }
      expect(await count('Shop')).toBe(2);
    });

    it('a second call returns the same shops and creates no row and no event', async () => {
      const [u1, u2] = await sellers(2);
      const first = await provisioning.ensureShopsForLegacySellers([
        u1.id,
        u2.id,
      ]);
      const rows = [
        await count('Shop'),
        await count('ShopMembership'),
        await count('ShopDirectory'),
        await eventCount(),
      ];
      const second = await provisioning.ensureShopsForLegacySellers([
        u2.id,
        u1.id,
      ]);
      expect(second).toEqual(first);
      expect([
        await count('Shop'),
        await count('ShopMembership'),
        await count('ShopDirectory'),
        await eventCount(),
      ]).toEqual(rows);
    });

    it('two concurrent calls converge on one shop per seller', async () => {
      const users = await sellers(6);
      const ids = users.map((u) => u.id);
      const [a, b] = await Promise.all([
        provisioning.ensureShopsForLegacySellers(ids),
        provisioning.ensureShopsForLegacySellers([...ids].reverse()),
      ]);
      expect(a).toEqual(b);
      expect(await count('Shop')).toBe(6);
      expect(await count('ShopMembership')).toBe(6);
      expect(await count('ShopDirectory')).toBe(6);
    });

    it('refuses more than 200 distinct sellers with a validation error and writes nothing', async () => {
      const ids = Array.from({ length: 201 }, () => uuidv7());
      await expect(
        provisioning.ensureShopsForLegacySellers(ids),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      await expect(
        provisioning.ensureShopsForLegacySellers([
          ...ids.slice(0, 200),
          ...ids.slice(0, 100),
        ]),
      ).resolves.toBeInstanceOf(Map);
      expect(await count('Shop')).toBe(200);
    });

    it('a failure on the third seller rolls the whole batch back, and a retry converges', async () => {
      const users = await sellers(4);
      const ids = users.map((u) => u.id).sort();
      await sequelize.query(`
        CREATE OR REPLACE FUNCTION tenancy_test_fail_member() RETURNS trigger AS $$
        BEGIN
          IF NEW."userId" = '${ids[2]}' THEN RAISE EXCEPTION 'forced failure'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER tenancy_test_fail_member BEFORE INSERT ON "ShopMembership" FOR EACH ROW EXECUTE FUNCTION tenancy_test_fail_member();`);
      try {
        await expect(
          provisioning.ensureShopsForLegacySellers(ids),
        ).rejects.toThrow();
        expect(await count('Shop')).toBe(0);
        expect(await count('ShopMembership')).toBe(0);
        expect(await count('ShopDirectory')).toBe(0);
        expect(await eventCount()).toBe(0);
      } finally {
        await sequelize.query(
          `DROP TRIGGER IF EXISTS tenancy_test_fail_member ON "ShopMembership"; DROP FUNCTION IF EXISTS tenancy_test_fail_member();`,
        );
      }
      const map = await provisioning.ensureShopsForLegacySellers(ids);
      expect(map.size).toBe(4);
      expect(await count('Shop')).toBe(4);
    });
  });

  describe('S03 AS-63: sandbox shops', () => {
    it('creates exactly one sandbox for a live shop, however often or concurrently it is asked', async () => {
      const owner = await t.newUser();
      const live = await createShop(t.app, owner, {
        slug: 'live-shop',
        name: 'Live',
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          provisioning.ensureSandboxShop(live.id),
        ),
      );
      const again = await provisioning.ensureSandboxShop(live.id);

      for (const r of [...results, again])
        expect(r).toMatchObject({
          slug: 'live-shop-sandbox',
          isSandbox: true,
          sandboxOf: live.id,
          status: 'ACTIVE',
        });
      expect(new Set([...results, again].map((r) => r.id)).size).toBe(1);
      expect(JSON.stringify(again)).not.toMatch(/stripe/i);
      expect(
        await sql(`SELECT "id" FROM "Shop" WHERE "sandboxOf" = :id`, {
          id: live.id,
        }),
      ).toHaveLength(1);
      expect(
        await sql(`SELECT 1 FROM "ShopMembership" WHERE "shopId" = :id`, {
          id: again.id,
        }),
      ).toHaveLength(0);
      expect(
        await sql(`SELECT 1 FROM "ShopDirectory" WHERE "shopId" = :id`, {
          id: again.id,
        }),
      ).toHaveLength(1);
      const created = (await outboxRowsFor(t.app, again.id)).filter(
        (e) => e.type === 'tenancy.shop_created',
      );
      expect(created).toHaveLength(1);
      expect(created[0].payload).toMatchObject({
        payload: { shopId: again.id, ownerId: null },
      });
    });

    it('answers not-found for an unknown live shop and refuses a sandbox of a sandbox', async () => {
      const owner = await t.newUser();
      const live = await createShop(t.app, owner, { slug: 'another-live' });
      await expect(
        provisioning.ensureSandboxShop(uuidv7()),
      ).rejects.toMatchObject({ code: 'shop_not_found' });
      const sandbox = await provisioning.ensureSandboxShop(live.id);
      await expect(
        provisioning.ensureSandboxShop(sandbox.id),
      ).rejects.toMatchObject({ status: 400 });
      expect(
        await sql(`SELECT 1 FROM "Shop" WHERE "sandboxOf" IS NOT NULL`),
      ).toHaveLength(1);
    });

    it('a sandbox shop never appears in "my shops"', async () => {
      const owner = await t.newUser();
      const live = await createShop(t.app, owner, { slug: 'visible-live' });
      await provisioning.ensureSandboxShop(live.id);
      const res = await t.as(owner).get('/api/shops/mine').expect(200);
      expect(res.body.items.map((i: { slug: string }) => i.slug)).toEqual([
        'visible-live',
      ]);
    });
  });
});
