import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { connectAs, ensureProbeRole } from '@app/test/utils/tenancy-roles';
import {
  createTenancyApp,
  type TenancyTestApp,
  type TestUser,
} from './testing/tenancy-app';

const PROBE = 'tenancy_probe_legacy';

/**
 * The original SD-02 end-to-end cases (BOLA, invite → accept → role, write skew, RLS backstop, cache invalidation,
 * seller promotion), kept as one regression spec on the S03 API. Each case is also covered in depth by the
 * feature-named specs next to this file.
 */
describe('Multi-tenant shops (e2e)', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  const sql = <R extends object>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<R>(query, { type: QueryTypes.SELECT, replacements });
  const probeAs = (user: TestUser, shopId: string, permission: string) =>
    t.as(user).get(`/api/probe/shop/${permission}`).set('X-Shop-Id', shopId);

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  it('S03 AS-09: BOLA: a member of shop A gets 404 (not 403) for shop B and its members', async () => {
    const alice = await t.newUser();
    const bob = await t.newUser();
    const shopA = await createShop(t.app, alice);
    const shopB = await createShop(t.app, bob);

    await t.as(alice).get(`/api/shops/${shopA.id}`).expect(200);
    const foreign = await t.as(alice).get(`/api/shops/${shopB.id}`).expect(404);
    expect(foreign.body.code).toBe('shop_not_found');
    await t.as(alice).get(`/api/shops/${shopB.id}/members`).expect(404);
    await probeAs(alice, shopB.id, 'shop.read').expect(404);
    await probeAs(alice, shopA.id, 'shop.read').expect(200);
  });

  it('S03 AS-32: invite → accept → role permissions: VIEWER can read but not manage, and the invite is single use', async () => {
    const owner = await t.newUser();
    const viewer = await t.newUser();
    const shop = await createShop(t.app, owner);

    const created = await t
      .as(owner)
      .post(`/api/shops/${shop.id}/invites`)
      .send({ email: viewer.email, role: 'VIEWER' })
      .expect(201);
    expect(JSON.stringify(created.body)).not.toContain('token');
    const [{ body }] = (await outboxRowsFor(t.app, shop.id))
      .filter((e) => e.kind === 'task')
      .map((e) => e.payload as { body: { token: string } });
    const token = body.token;
    await t
      .as(viewer)
      .post('/api/shop-invites/accept')
      .send({ token })
      .expect(201);

    await t.as(viewer).get(`/api/shops/${shop.id}`).expect(200);
    await probeAs(viewer, shop.id, 'shop.read').expect(200);
    await probeAs(viewer, shop.id, 'shop.manage').expect(403);

    await t
      .as(viewer)
      .post('/api/shop-invites/accept')
      .send({ token })
      .expect(404);
  });

  it('S03 AS-23: write skew: two owners demoting each other at the same time cannot leave the shop ownerless', async () => {
    const a = await t.newUser();
    const b = await t.newUser();
    const shop = await createShop(t.app, a);
    await addMember(t.app, shop.id, b.id, 'OWNER', 'invite');

    const results = await Promise.all(
      [a, b].map((u) =>
        t
          .as(u)
          .patch(`/api/shops/${shop.id}/members/${u.id}`)
          .send({ role: 'ADMIN' }),
      ),
    );

    expect(results.filter((r) => r.status === 204)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    const owners = await sql(
      `SELECT "userId" FROM "ShopMembership" WHERE "shopId" = :shopId AND "role" = 'OWNER'`,
      { shopId: shop.id },
    );
    expect(owners).toHaveLength(1);
  });

  it('S03 AS-57: RLS backstop: invites are invisible outside their shop transaction', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    await createInvite(t.app, shop.id, {
      email: 'x@example.com',
      role: 'STAFF',
      invitedBy: owner.id,
    });

    // The test database connects as a superuser, which bypasses RLS even with FORCE: probe the policy as a plain role.
    await ensureProbeRole(sequelize, { name: PROBE });
    const probe = connectAs(sequelize, PROBE);
    try {
      const visible = await probe.transaction(async (transaction) => {
        const [row] = await probe.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "ShopInvite"`,
          { type: QueryTypes.SELECT, transaction },
        );
        return row.n;
      });
      expect(visible).toBe(0); // no app.shop_id set → the policy filters everything
      const scoped = await probe.transaction(async (transaction) => {
        await probe.query(`SELECT set_config('app.shop_id', :id, true)`, {
          replacements: { id: shop.id },
          transaction,
        });
        const [row] = await probe.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "ShopInvite"`,
          { type: QueryTypes.SELECT, transaction },
        );
        return row.n;
      });
      expect(scoped).toBe(1);
    } finally {
      await probe.close();
    }
    const listed = await t.as(owner).get(`/api/shops/${shop.id}/invites`);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
  });

  it('S03 AS-13: membership changes take effect immediately (cache invalidated)', async () => {
    const owner = await t.newUser();
    const staff = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, staff.id, 'STAFF');

    await t.as(staff).get(`/api/shops/${shop.id}`).expect(200); // warms the authorization cache
    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${staff.id}`)
      .expect(204);
    await t.as(staff).get(`/api/shops/${shop.id}`).expect(404);
    await probeAs(staff, shop.id, 'shop.read').expect(404);
  });

  it('S03 AS-01: opening a shop makes the owner an OWNER member, lists it under mine, and does not touch the account', async () => {
    const owner = await t.newUser();
    const before = await sql<{ role: string }>(
      `SELECT "role" FROM "User" WHERE "id" = :id`,
      { id: owner.id },
    );
    expect(before[0].role).toBe('USER');

    const res = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Acme', slug: 'acme-legacy' })
      .expect(201);
    expect(res.body.slug).toBe('acme-legacy');

    const after = await sql<{ role: string }>(
      `SELECT "role" FROM "User" WHERE "id" = :id`,
      { id: owner.id },
    );
    expect(after[0].role).toBe('USER');
    const mine = await t.as(owner).get('/api/shops/mine').expect(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0].id).toBe(res.body.id);
    const member = await sql<{ role: string; source: string }>(
      `SELECT "role","source" FROM "ShopMembership" WHERE "shopId" = :id AND "userId" = :u`,
      { id: res.body.id, u: owner.id },
    );
    expect(member).toEqual([{ role: 'OWNER', source: 'owner' }]);
  });
});
