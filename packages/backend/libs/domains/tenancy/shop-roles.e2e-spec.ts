import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { shopRolesSchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { ROLE_PERMISSIONS, SHOP_PERMISSIONS } from './domain/permissions';
import { SHOP_ROLES, type ShopRole } from './domain/shop-types';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

type Method = 'get' | 'post' | 'patch' | 'delete';

describe('Roles and permissions', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  const team = async () => {
    const users = {} as Record<
      ShopRole,
      Awaited<ReturnType<TenancyTestApp['newUser']>>
    >;
    for (const role of SHOP_ROLES) users[role] = await t.newUser();
    const shop = await createShop(t.app, users.OWNER, { plan: 'PRO' });
    for (const role of ['ADMIN', 'STAFF', 'VIEWER'] as const)
      await addMember(t.app, shop.id, users[role].id, role);
    return { users, shop };
  };
  const call = (
    user: Awaited<ReturnType<TenancyTestApp['newUser']>>,
    method: Method,
    url: string,
    body?: object,
  ) => {
    const agent = t.as(user) as unknown as Record<
      string,
      (u: string) => import('supertest').Test
    >;
    return agent[method](url).send(body ?? {});
  };

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-11: every role gets, on every permission-guarded route, exactly the outcome of the matrix', async () => {
    const { users, shop } = await team();
    for (const role of SHOP_ROLES)
      for (const permission of SHOP_PERMISSIONS) {
        const res = await t
          .as(users[role])
          .get(`/api/probe/shop/${permission}`)
          .set('X-Shop-Id', shop.id);
        const allowed = (ROLE_PERMISSIONS[role] as readonly string[]).includes(
          permission,
        );
        expect([role, permission, res.status]).toEqual([
          role,
          permission,
          allowed ? 200 : 403,
        ]);
        if (!allowed) expect(res.body.code).toBe('permission_denied');
      }
  });

  it('S03 AS-11: the real routes of this capability follow the same matrix', async () => {
    const { users, shop } = await team();
    const target = await t.newUser();
    await addMember(t.app, shop.id, target.id, 'VIEWER');
    const routes: Array<{
      name: string;
      permission: string;
      call: (u: (typeof users)[ShopRole]) => import('supertest').Test;
    }> = [
      {
        name: 'read shop',
        permission: 'shop.read',
        call: (u) => call(u, 'get', `/api/shops/${shop.id}`),
      },
      {
        name: 'rename shop',
        permission: 'shop.manage',
        call: (u) =>
          call(u, 'patch', `/api/shops/${shop.id}`, { name: 'Named' }),
      },
      {
        name: 'list members',
        permission: 'members.read',
        call: (u) => call(u, 'get', `/api/shops/${shop.id}/members`),
      },
      {
        name: 'list invites',
        permission: 'members.manage',
        call: (u) => call(u, 'get', `/api/shops/${shop.id}/invites`),
      },
      {
        name: 'create invite',
        permission: 'members.manage',
        call: (u) =>
          call(u, 'post', `/api/shops/${shop.id}/invites`, {
            email: `${u.id}@example.com`,
            role: 'VIEWER',
          }),
      },
      {
        name: 'change a role',
        permission: 'members.manage',
        call: (u) =>
          call(u, 'patch', `/api/shops/${shop.id}/members/${target.id}`, {
            role: 'VIEWER',
          }),
      },
    ];
    for (const route of routes)
      for (const role of SHOP_ROLES) {
        const res = await route.call(users[role]);
        const allowed = (ROLE_PERMISSIONS[role] as readonly string[]).includes(
          route.permission,
        );
        if (allowed)
          expect([route.name, role, res.status < 300]).toEqual([
            route.name,
            role,
            true,
          ]);
        else
          expect([route.name, role, res.status, res.body.code]).toEqual([
            route.name,
            role,
            403,
            'permission_denied',
          ]);
      }
  });

  it('S03 AS-19: an admin cannot escalate; each attempt is 403 insufficient_role with no change and no event', async () => {
    const { users, shop } = await team();
    const second = await t.newUser();
    await addMember(t.app, shop.id, second.id, 'ADMIN');
    const members = () =>
      sequelize.query(
        `SELECT "userId","role" FROM "ShopMembership" ORDER BY "userId"`,
        { type: QueryTypes.SELECT },
      );
    const invites = () =>
      sequelize.query(`SELECT 1 FROM "ShopInvite"`, {
        type: QueryTypes.SELECT,
      });
    const before = await members();
    const eventsBefore = (await outboxRowsFor(t.app, shop.id)).length;

    const attempts: Array<[string, import('supertest').Test]> = [
      [
        'promote STAFF to ADMIN',
        call(
          users.ADMIN,
          'patch',
          `/api/shops/${shop.id}/members/${users.STAFF.id}`,
          { role: 'ADMIN' },
        ),
      ],
      [
        'promote STAFF to OWNER',
        call(
          users.ADMIN,
          'patch',
          `/api/shops/${shop.id}/members/${users.STAFF.id}`,
          { role: 'OWNER' },
        ),
      ],
      [
        'promote self to OWNER',
        call(
          users.ADMIN,
          'patch',
          `/api/shops/${shop.id}/members/${users.ADMIN.id}`,
          { role: 'OWNER' },
        ),
      ],
      [
        'demote an OWNER',
        call(
          users.ADMIN,
          'patch',
          `/api/shops/${shop.id}/members/${users.OWNER.id}`,
          { role: 'VIEWER' },
        ),
      ],
      [
        'demote another ADMIN',
        call(
          users.ADMIN,
          'patch',
          `/api/shops/${shop.id}/members/${second.id}`,
          { role: 'STAFF' },
        ),
      ],
      [
        'remove an OWNER',
        call(
          users.ADMIN,
          'delete',
          `/api/shops/${shop.id}/members/${users.OWNER.id}`,
        ),
      ],
      [
        'remove another ADMIN',
        call(
          users.ADMIN,
          'delete',
          `/api/shops/${shop.id}/members/${second.id}`,
        ),
      ],
      [
        'invite an ADMIN',
        call(users.ADMIN, 'post', `/api/shops/${shop.id}/invites`, {
          email: 'new.admin@example.com',
          role: 'ADMIN',
        }),
      ],
    ];
    for (const [name, req] of attempts) {
      const res = await req;
      expect([name, res.status, res.body.code]).toEqual([
        name,
        403,
        'insufficient_role',
      ]);
    }
    expect(await members()).toEqual(before);
    expect(await invites()).toHaveLength(0);
    expect((await outboxRowsFor(t.app, shop.id)).length).toBe(eventsBefore);

    await call(
      users.ADMIN,
      'patch',
      `/api/shops/${shop.id}/members/${users.VIEWER.id}`,
      { role: 'STAFF' },
    ).expect(204);
    const [row] = await sequelize.query<{ role: string }>(
      `SELECT "role" FROM "ShopMembership" WHERE "userId" = :id`,
      { type: QueryTypes.SELECT, replacements: { id: users.VIEWER.id } },
    );
    expect(row.role).toBe('STAFF');
  });

  it('S03 AS-82: GET /shop-roles serves the matrix and parses with its contract; it needs credentials', async () => {
    const user = await t.newUser();
    const res = await t.as(user).get('/api/shop-roles').expect(200);
    const body = shopRolesSchema.parse(res.body);
    for (const role of SHOP_ROLES)
      expect([...body.roles[role]].sort()).toEqual(
        [...ROLE_PERMISSIONS[role]].sort(),
      );
    expect([...body.permissions].sort()).toEqual([...SHOP_PERMISSIONS].sort());
    expect(body.roles.VIEWER).not.toContain('payouts.read');
    expect(body.roles.ADMIN).not.toContain('sso.manage');
    expect(body.roles.VIEWER).toContain('orders.read');
    expect(body.roles.OWNER).toContain('shop.export');
    await t.http().get('/api/shop-roles').expect(401);
  });
});
