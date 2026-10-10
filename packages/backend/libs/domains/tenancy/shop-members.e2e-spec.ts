import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { pageSchema, shopMemberSchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  SessionRevocationService,
  UserDirectoryService,
} from '@app/domains/identity';
import { ShopTopicsModule } from './realtime-topics.module';
import { SHOP_ROLES, type ShopRole } from './domain/shop-types';
import {
  createTenancyApp,
  type TenancyTestApp,
  type TestUser,
} from './testing/tenancy-app';

const membersPage = pageSchema(shopMemberSchema);

describe('Team membership', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  const sql = <R extends object>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<R>(query, { type: QueryTypes.SELECT, replacements });
  const roleOf = async (shopId: string, userId: string) =>
    (
      await sql<{ role: string }>(
        `SELECT "role" FROM "ShopMembership" WHERE "shopId" = :shopId AND "userId" = :userId`,
        {
          shopId,
          userId,
        },
      )
    )[0]?.role;
  const events = async (shopId: string, type: string) =>
    (await outboxRowsFor(t.app, shopId)).filter((e) => e.type === type);
  const startsWithMember = (type: string | null) =>
    !!type?.startsWith('tenancy.member_');
  const racePairs = Number(process.env.TENANCY_RACE_PAIRS ?? 20);

  beforeAll(async () => {
    t = await createTenancyApp({ extraImports: [ShopTopicsModule] });
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
  });

  it('S03 AS-20: the members page resolves every address with one batched directory call; an SSO member has no address', async () => {
    const owner = await t.newUser();
    const staff = await t.newUser();
    const sso = await t.newUser();
    await sequelize.query(`UPDATE "User" SET "email" = NULL WHERE "id" = :id`, {
      replacements: { id: sso.id },
    });
    const shop = await createShop(t.app, owner);
    await addMember(
      t.app,
      shop.id,
      staff.id,
      'STAFF',
      'invite',
      new Date(Date.UTC(2026, 0, 2)),
    );
    await addMember(
      t.app,
      shop.id,
      sso.id,
      'VIEWER',
      'sso',
      new Date(Date.UTC(2026, 0, 3)),
    );
    await sequelize.query(
      `UPDATE "ShopMembership" SET "createdAt" = :at WHERE "userId" = :id`,
      {
        replacements: { at: new Date(Date.UTC(2026, 0, 1)), id: owner.id },
      },
    );
    const directory = jest.spyOn(
      t.app.get(UserDirectoryService),
      'getUsersByIds',
    );

    const first = await t
      .as(owner)
      .get(`/api/shops/${shop.id}/members?limit=2`)
      .expect(200);
    expect(directory).toHaveBeenCalledTimes(1);
    const page1 = membersPage.parse(first.body);
    expect(
      page1.items.map((m) => [m.userId, m.email, m.role, m.source]),
    ).toEqual([
      [owner.id, owner.email, 'OWNER', 'owner'],
      [staff.id, staff.email, 'STAFF', 'invite'],
    ]);
    expect(page1.nextCursor).toEqual(expect.any(String));

    directory.mockClear();
    const second = await t
      .as(owner)
      .get(`/api/shops/${shop.id}/members?limit=2&cursor=${page1.nextCursor}`)
      .expect(200);
    expect(directory).toHaveBeenCalledTimes(1);
    const page2 = membersPage.parse(second.body);
    expect(page2.items).toEqual([
      expect.objectContaining({
        userId: sso.id,
        email: null,
        role: 'VIEWER',
        source: 'sso',
      }),
    ]);
    expect(page2.nextCursor).toBeNull();

    for (const query of ['cursor=garbage', 'limit=101'])
      expect(
        (
          await t
            .as(owner)
            .get(`/api/shops/${shop.id}/members?${query}`)
            .expect(400)
        ).body.code,
      ).toBe('validation_failed');
    await t
      .as(await t.newUser())
      .get(`/api/shops/${shop.id}/members`)
      .expect(404);
  });

  it('S03 AS-21: changing a role updates the row and emits one event; the same role is a 204 without an event', async () => {
    const owner = await t.newUser();
    const member = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, member.id, 'STAFF');

    await t
      .as(owner)
      .patch(`/api/shops/${shop.id}/members/${member.id}`)
      .send({ role: 'ADMIN' })
      .expect(204);
    expect(await roleOf(shop.id, member.id)).toBe('ADMIN');
    const changed = await events(shop.id, 'tenancy.member_role_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].payload).toMatchObject({
      aggregateId: shop.id,
      payload: {
        shopId: shop.id,
        userId: member.id,
        from: 'STAFF',
        to: 'ADMIN',
      },
    });

    await t
      .as(owner)
      .patch(`/api/shops/${shop.id}/members/${member.id}`)
      .send({ role: 'ADMIN' })
      .expect(204);
    expect(await events(shop.id, 'tenancy.member_role_changed')).toHaveLength(
      1,
    );

    const unknown = await t
      .as(owner)
      .patch(`/api/shops/${shop.id}/members/${(await t.newUser()).id}`)
      .send({ role: 'ADMIN' })
      .expect(404);
    expect(unknown.body.code).toBe('member_not_found');
    for (const body of [{ role: 'SUPERUSER' }, {}, { role: 'ADMIN', extra: 1 }])
      expect(
        (
          await t
            .as(owner)
            .patch(`/api/shops/${shop.id}/members/${member.id}`)
            .send(body)
            .expect(400)
        ).body.code,
      ).toBe('validation_failed');
    expect(await roleOf(shop.id, member.id)).toBe('ADMIN');
  });

  it('S03 AS-22: the last owner can neither demote nor remove themselves (409 last_owner), and nothing changes', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    const demote = await t
      .as(owner)
      .patch(`/api/shops/${shop.id}/members/${owner.id}`)
      .send({ role: 'ADMIN' })
      .expect(409);
    expect(demote.body.code).toBe('last_owner');
    const leave = await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${owner.id}`)
      .expect(409);
    expect(leave.body.code).toBe('last_owner');
    expect(await roleOf(shop.id, owner.id)).toBe('OWNER');
    expect(
      (await outboxRowsFor(t.app, shop.id)).filter((e) =>
        startsWithMember(e.type),
      ),
    ).toHaveLength(0);

    const second = await t.newUser();
    await addMember(t.app, shop.id, second.id, 'OWNER');
    await t
      .as(owner)
      .patch(`/api/shops/${shop.id}/members/${owner.id}`)
      .send({ role: 'ADMIN' })
      .expect(204);
  });

  it(`S03 AS-23: two owners acting on each other at once leave an owner, and exactly one wins (${racePairs} repetitions)`, async () => {
    for (let i = 0; i < racePairs; i++) {
      await t.reset();
      const a = await t.newUser();
      const b = await t.newUser();
      const shop = await createShop(t.app, a);
      await addMember(t.app, shop.id, b.id, 'OWNER');
      const mode = i % 2;
      const [ra, rb] = await Promise.all(
        mode === 0
          ? [
              t
                .as(a)
                .patch(`/api/shops/${shop.id}/members/${b.id}`)
                .send({ role: 'ADMIN' }),
              t
                .as(b)
                .patch(`/api/shops/${shop.id}/members/${a.id}`)
                .send({ role: 'ADMIN' }),
            ]
          : [
              t.as(a).delete(`/api/shops/${shop.id}/members/${b.id}`),
              t
                .as(b)
                .patch(`/api/shops/${shop.id}/members/${a.id}`)
                .send({ role: 'VIEWER' }),
            ],
      );
      const statuses = [ra.status, rb.status];
      expect(statuses.filter((s) => s === 204)).toHaveLength(1);
      const failed = [ra, rb].find((r) => r.status !== 204)!;
      expect([403, 409]).toContain(failed.status);
      const owners = await sql<{ n: string }>(
        `SELECT count(*) AS n FROM "ShopMembership" WHERE "shopId" = :id AND "role" = 'OWNER'`,
        { id: shop.id },
      );
      expect(Number(owners[0].n)).toBe(1);
    }
  });

  describe('S03 AS-24: serialization failures', () => {
    const installTrigger = async (failures: number) => {
      await sequelize.query(`
        DROP SEQUENCE IF EXISTS tenancy_test_attempts;
        CREATE SEQUENCE tenancy_test_attempts;
        CREATE OR REPLACE FUNCTION tenancy_test_fail() RETURNS trigger AS $$
        BEGIN
          IF nextval('tenancy_test_attempts') <= ${failures} THEN
            RAISE EXCEPTION 'forced' USING ERRCODE = '40001';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        DROP TRIGGER IF EXISTS tenancy_test_fail ON "ShopMembership";
        CREATE TRIGGER tenancy_test_fail BEFORE UPDATE ON "ShopMembership" FOR EACH ROW EXECUTE FUNCTION tenancy_test_fail();`);
    };
    const attempts = async () =>
      (
        await sql<{ last_value: string; is_called: boolean }>(
          `SELECT last_value, is_called FROM tenancy_test_attempts`,
        )
      ).map((r) => (r.is_called ? Number(r.last_value) : 0))[0];
    afterEach(() =>
      sequelize.query(
        `DROP TRIGGER IF EXISTS tenancy_test_fail ON "ShopMembership"; DROP FUNCTION IF EXISTS tenancy_test_fail(); DROP SEQUENCE IF EXISTS tenancy_test_attempts;`,
      ),
    );

    it('is retried and succeeds when the conflict goes away', async () => {
      const owner = await t.newUser();
      const member = await t.newUser();
      const shop = await createShop(t.app, owner);
      await addMember(t.app, shop.id, member.id, 'STAFF');
      await installTrigger(2);
      await t
        .as(owner)
        .patch(`/api/shops/${shop.id}/members/${member.id}`)
        .send({ role: 'ADMIN' })
        .expect(204);
      expect(await attempts()).toBe(3);
      expect(await roleOf(shop.id, member.id)).toBe('ADMIN');
    });

    it('is retried at most three times, then answers 503 serialization_failure with Retry-After and changes nothing', async () => {
      const owner = await t.newUser();
      const member = await t.newUser();
      const shop = await createShop(t.app, owner);
      await addMember(t.app, shop.id, member.id, 'STAFF');
      await installTrigger(1000);
      const res = await t
        .as(owner)
        .patch(`/api/shops/${shop.id}/members/${member.id}`)
        .send({ role: 'ADMIN' })
        .expect(503);
      expect(res.body.code).toBe('serialization_failure');
      expect(res.headers['retry-after']).toBeDefined();
      expect(await attempts()).toBe(3);
      expect(await roleOf(shop.id, member.id)).toBe('STAFF');
      expect(await events(shop.id, 'tenancy.member_role_changed')).toHaveLength(
        0,
      );
    });
  });

  it('S03 AS-25: every role may leave on its own; a viewer cannot remove anybody else', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner, { plan: 'PRO' });
    const others = {} as Record<ShopRole, TestUser>;
    for (const role of ['ADMIN', 'STAFF', 'VIEWER'] as const) {
      others[role] = await t.newUser();
      await addMember(t.app, shop.id, others[role].id, role);
    }
    const second = await t.newUser();
    await addMember(t.app, shop.id, second.id, 'OWNER');

    const denied = await t
      .as(others.VIEWER)
      .delete(`/api/shops/${shop.id}/members/${others.STAFF.id}`)
      .expect(403);
    expect(denied.body.code).toBe('permission_denied');
    expect(await roleOf(shop.id, others.STAFF.id)).toBe('STAFF');

    for (const [role, user] of [
      ['VIEWER', others.VIEWER],
      ['STAFF', others.STAFF],
      ['ADMIN', others.ADMIN],
      ['OWNER', second],
    ] as const) {
      await t
        .as(user)
        .delete(`/api/shops/${shop.id}/members/${user.id}`)
        .expect(204);
      expect([role, await roleOf(shop.id, user.id)]).toEqual([role, undefined]);
    }
    const left = await events(shop.id, 'tenancy.member_removed');
    expect(
      left.map(
        (e) => (e.payload as { payload: { reason: string } }).payload.reason,
      ),
    ).toEqual(['left', 'left', 'left', 'left']);
    await t.as(others.VIEWER).get(`/api/shops/${shop.id}`).expect(404);
  });

  it('S03 AS-26: removing an SSO member ends their sessions after commit; removing a password member keeps theirs', async () => {
    const owner = await t.newUser();
    const sso = await t.newUser();
    const plain = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, sso.id, 'VIEWER', 'sso');
    await addMember(t.app, shop.id, plain.id, 'VIEWER', 'invite');
    const revoke = jest.spyOn(
      t.app.get(SessionRevocationService),
      'revokeAllForUser',
    );

    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${sso.id}`)
      .expect(204);
    expect(revoke).toHaveBeenCalledWith(sso.id, 'shop_membership_removed');
    expect((await t.session(sso.sessionId))?.revokedAt).toBeTruthy();

    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${plain.id}`)
      .expect(204);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect((await t.session(plain.sessionId))?.revokedAt).toBeFalsy();
    const removed = await events(shop.id, 'tenancy.member_removed');
    expect(
      removed.map(
        (e) => (e.payload as { payload: { reason: string } }).payload.reason,
      ),
    ).toEqual(['removed', 'removed']);
  });

  it('S03 AS-27: a removed member is refused on the live topic of the shop; AS-83: only members of ACTIVE or SUSPENDED shops may subscribe', async () => {
    const topics = t.app.get(TopicRegistry);
    const owner = await t.newUser();
    const member = await t.newUser();
    const outsider = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, member.id, 'VIEWER');
    const topic = `shop:${shop.id}:live`;
    const can = (u: TestUser) => topics.canSubscribe({ userId: u.id }, topic);

    expect(await can(member)).toBe(true);
    expect(await can(outsider)).toBe(false);
    expect(await topics.canSubscribe({}, topic)).toBe(false);

    for (const [status, allowed] of [
      ['SUSPENDED', true],
      ['DELETING', false],
      ['DELETED', false],
      ['ACTIVE', true],
    ] as const) {
      await sequelize.query(
        `UPDATE "Shop" SET "status" = :status WHERE "id" = :id`,
        { replacements: { status, id: shop.id } },
      );
      expect([status, await can(member)]).toEqual([status, allowed]);
    }
    await t
      .as(owner)
      .delete(`/api/shops/${shop.id}/members/${member.id}`)
      .expect(204);
    expect(await can(member)).toBe(false);
  });

  it('S03 FR-090: the 121st write in a minute on one shop is 429 with Retry-After; another shop is unaffected', async () => {
    const owner = await t.newUser();
    const member = await t.newUser();
    const shop = await createShop(t.app, owner);
    const other = await createShop(t.app, owner);
    await addMember(t.app, shop.id, member.id, 'STAFF');
    await addMember(t.app, other.id, member.id, 'STAFF');
    let last = 0;
    for (let i = 0; i < 120; i++)
      last = (
        await t
          .as(owner)
          .patch(`/api/shops/${shop.id}/members/${member.id}`)
          .send({ role: 'STAFF' })
      ).status;
    expect(last).toBe(204);
    const limited = await t
      .as(owner)
      .patch(`/api/shops/${shop.id}/members/${member.id}`)
      .send({ role: 'STAFF' })
      .expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    await t
      .as(owner)
      .patch(`/api/shops/${other.id}/members/${member.id}`)
      .send({ role: 'ADMIN' })
      .expect(204);
    expect(SHOP_ROLES).toContain('ADMIN');
  });
});
