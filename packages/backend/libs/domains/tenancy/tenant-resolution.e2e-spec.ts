import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { AUTHZ_CACHE, type AuthzCache } from './domain/ports';
import { SENSITIVE_PERMISSIONS, SHOP_PERMISSIONS } from './domain/permissions';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

const UNKNOWN = '018f0000-0000-7000-8000-000000000000';
const MALFORMED = 'not-a-uuid';

describe('Tenant resolution and isolation', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let cache: AuthzCache;

  const sql = <R extends object>(
    query: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<R>(query, { type: QueryTypes.SELECT, replacements });
  const probe = (permission: string | undefined) =>
    `/api/probe/shop/${permission ?? 'member'}`;
  const denied = (reason: string) =>
    MetricsRegistry.value('tenancy_authz_denied_total', { reason }) ?? 0;

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
    cache = t.app.get(AUTHZ_CACHE);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('S03 AS-05: every endpoint needs credentials', () => {
    const shopId = UNKNOWN;
    const routes: Array<[string, string]> = [
      ['post', '/api/shops'],
      ['get', '/api/shops/mine'],
      ['get', `/api/shops/${shopId}`],
      ['patch', `/api/shops/${shopId}`],
      ['get', `/api/shops/${shopId}/members`],
      ['patch', `/api/shops/${shopId}/members/${UNKNOWN}`],
      ['delete', `/api/shops/${shopId}/members/${UNKNOWN}`],
      ['get', `/api/shops/${shopId}/invites`],
      ['post', `/api/shops/${shopId}/invites`],
      ['post', `/api/shops/${shopId}/invites/${UNKNOWN}/resend`],
      ['delete', `/api/shops/${shopId}/invites/${UNKNOWN}`],
      ['post', '/api/shop-invites/accept'],
      ['get', '/api/shop-roles'],
      ['put', `/api/shops/${shopId}/sso`],
    ];

    it.each(routes)(
      '%s %s without a token -> 401 invalid_token',
      async (method, url) => {
        const http = t.http() as unknown as Record<
          string,
          (u: string) => import('supertest').Test
        >;
        const res = await http[method](url).send({}).expect(401);
        expect(res.body.code).toBe('invalid_token');
        const bad = await http[method](url)
          .set('Authorization', 'Bearer not.a.token')
          .send({})
          .expect(401);
        expect(bad.body.code).toBe('invalid_token');
      },
    );
  });

  describe('S03 AS-09: another shop, an unknown shop and a malformed id are indistinguishable', () => {
    it('answers the identical 404 shop_not_found on every shop route and changes nothing', async () => {
      const mine = await t.newUser();
      const stranger = await t.newUser();
      const shopA = await createShop(t.app, mine, {
        name: 'A',
        slug: 'shop-a',
      });
      const shopB = await createShop(t.app, stranger, {
        name: 'B',
        slug: 'shop-b',
      });
      const { invite } = await createInvite(t.app, shopB.id, {
        email: 'x@example.com',
        invitedBy: stranger.id,
      });
      const before = await sql(`SELECT * FROM "Shop" ORDER BY "slug"`);
      const beforeMembers = await sql(
        `SELECT * FROM "ShopMembership" ORDER BY "shopId","userId"`,
      );
      const beforeInvites = await sql(`SELECT * FROM "ShopInvite"`);
      const beforeCount = denied('not_member');

      const calls = (id: string): Array<[string, string, object?]> => [
        ['get', `/api/shops/${id}`],
        ['patch', `/api/shops/${id}`, { name: 'Hacked' }],
        ['get', `/api/shops/${id}/members`],
        [
          'patch',
          `/api/shops/${id}/members/${stranger.id}`,
          { role: 'VIEWER' },
        ],
        ['delete', `/api/shops/${id}/members/${stranger.id}`],
        ['get', `/api/shops/${id}/invites`],
        [
          'post',
          `/api/shops/${id}/invites`,
          { email: 'new@example.com', role: 'STAFF' },
        ],
        ['post', `/api/shops/${id}/invites/${invite.id}/resend`],
        ['delete', `/api/shops/${id}/invites/${invite.id}`],
        [
          'put',
          `/api/shops/${id}/sso`,
          {
            issuer: 'https://idp.example.com',
            clientId: 'c',
            clientSecret: 's',
          },
        ],
      ];
      let attempts = 0;
      for (let i = 0; i < calls(shopB.id).length; i++) {
        const bodies: Array<Record<string, unknown>> = [];
        for (const id of [shopB.id, UNKNOWN, MALFORMED]) {
          const [method, url, body] = calls(id)[i];
          const agent = t.as(mine) as unknown as Record<
            string,
            (u: string) => import('supertest').Test
          >;
          const res = await agent[method](url).send(body ?? {});
          attempts++;
          expect(res.status).toBe(404);
          const { code, title, status, detail } = res.body;
          bodies.push({ code, title, status, detail });
        }
        expect(bodies[0].code).toBe('shop_not_found');
        expect(bodies[1]).toEqual(bodies[0]);
        expect(bodies[2]).toEqual(bodies[0]);
      }
      expect(await sql(`SELECT * FROM "Shop" ORDER BY "slug"`)).toEqual(before);
      expect(
        await sql(`SELECT * FROM "ShopMembership" ORDER BY "shopId","userId"`),
      ).toEqual(beforeMembers);
      expect(await sql(`SELECT * FROM "ShopInvite"`)).toEqual(beforeInvites);
      expect(denied('not_member') - beforeCount).toBe(attempts);
      expect(shopA.id).toBeDefined();
    });
  });

  describe('S03 AS-10: the shop comes from the path or the header, never the body', () => {
    it('works from the header alone, agrees with an equal path, and a disagreement is 400 shop_mismatch', async () => {
      const user = await t.newUser();
      const shopA = await createShop(t.app, user);
      const shopB = await createShop(t.app, user);

      const viaHeader = await t
        .as(user)
        .get(probe('shop.read'))
        .set('X-Shop-Id', shopA.id)
        .expect(200);
      expect(viaHeader.body).toMatchObject({ shopId: shopA.id, role: 'OWNER' });

      await t
        .as(user)
        .get(`/api/shops/${shopA.id}`)
        .set('X-Shop-Id', shopA.id)
        .expect(200);
      const mismatch = await t
        .as(user)
        .get(`/api/shops/${shopA.id}`)
        .set('X-Shop-Id', shopB.id)
        .expect(400);
      expect(mismatch.body.code).toBe('shop_mismatch');

      const noShop = await t.as(user).get(probe('shop.read')).expect(404);
      expect(noShop.body.code).toBe('shop_not_found');
    });

    it('a shopId in the body is 400 validation_failed', async () => {
      const user = await t.newUser();
      const shop = await createShop(t.app, user);
      const other = await createShop(t.app, user);
      const res = await t
        .as(user)
        .patch(`/api/shops/${shop.id}`)
        .send({ name: 'Renamed', shopId: other.id })
        .expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(
        await sql<{ name: string }>(
          `SELECT "name" FROM "Shop" WHERE "id" = :id`,
          { id: other.id },
        ),
      ).not.toEqual([{ name: 'Renamed' }]);
    });
  });

  describe('S03 AS-12: status gate and answer order', () => {
    const setStatus = async (shopId: string, status: string) => {
      await sequelize.query(
        `UPDATE "Shop" SET "status" = :status WHERE "id" = :shopId`,
        {
          replacements: { status, shopId },
        },
      );
      await cache.delete(shopId);
    };
    const call = (
      user: Awaited<ReturnType<TenancyTestApp['newUser']>>,
      shopId: string,
      permission: string,
    ) => t.as(user).get(probe(permission)).set('X-Shop-Id', shopId);

    it('SUSPENDED allows shop.read, members.read, shop.export and refuses the rest with 403 shop_suspended', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner, { status: 'SUSPENDED' });
      for (const p of ['shop.read', 'members.read', 'shop.export'])
        await call(owner, shop.id, p).expect(200);
      for (const p of SHOP_PERMISSIONS.filter(
        (x) => !['shop.read', 'members.read', 'shop.export'].includes(x),
      )) {
        const res = await call(owner, shop.id, p).expect(403);
        expect(res.body.code).toBe('shop_suspended');
      }
    });

    it('DELETING also allows shop.delete and refuses the rest with 409 shop_offboarding', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner, { status: 'DELETING' });
      for (const p of [
        'shop.read',
        'members.read',
        'shop.export',
        'shop.delete',
      ])
        await call(owner, shop.id, p).expect(200);
      for (const p of [
        'products.write',
        'shop.manage',
        'members.manage',
        'billing.manage',
      ]) {
        const res = await call(owner, shop.id, p).expect(409);
        expect(res.body.code).toBe('shop_offboarding');
      }
    });

    it('DELETED answers 404 shop_not_found everywhere', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner, { status: 'DELETED' });
      for (const p of ['shop.read', 'shop.delete', 'products.write']) {
        const res = await call(owner, shop.id, p).expect(404);
        expect(res.body.code).toBe('shop_not_found');
      }
    });

    it('a caller lacking the permission gets 403 permission_denied before any status answer', async () => {
      const owner = await t.newUser();
      const viewer = await t.newUser();
      const shop = await createShop(t.app, owner, { status: 'SUSPENDED' });
      await addMember(t.app, shop.id, viewer.id, 'VIEWER');
      const res = await call(viewer, shop.id, 'products.write').expect(403);
      expect(res.body.code).toBe('permission_denied');
      const closing = await createShop(t.app, owner, { status: 'DELETING' });
      await addMember(t.app, closing.id, viewer.id, 'VIEWER');
      expect(
        (await call(viewer, closing.id, 'shop.manage').expect(403)).body.code,
      ).toBe('permission_denied');
    });

    it('401 comes before 404, 404 before 403', async () => {
      const user = await t.newUser();
      const stranger = await t.newUser();
      const shop = await createShop(t.app, stranger);
      expect(
        (
          await t
            .http()
            .get(probe('shop.manage'))
            .set('X-Shop-Id', shop.id)
            .expect(401)
        ).body.code,
      ).toBe('invalid_token');
      expect(
        (await call(user, shop.id, 'shop.manage').expect(404)).body.code,
      ).toBe('shop_not_found');
    });
  });

  describe('S03 AS-13: the authorization cache is bounded and never the source of truth', () => {
    it('a member removed through the API is refused on the very next non-sensitive request', async () => {
      const owner = await t.newUser();
      const member = await t.newUser();
      const shop = await createShop(t.app, owner);
      await addMember(t.app, shop.id, member.id, 'STAFF');
      await t
        .as(member)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(200); // warms the cache
      expect(await cache.get(shop.id, member.id)).toMatchObject({
        state: 'hit',
      });

      await t
        .as(owner)
        .delete(`/api/shops/${shop.id}/members/${member.id}`)
        .expect(204);
      expect(await cache.get(shop.id, member.id)).toEqual({ state: 'miss' });
      await t
        .as(member)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(404);
    });

    it('a stale member entry written after the removal: sensitive routes still 404; the others answer from it for 15 s, then 404', async () => {
      const owner = await t.newUser();
      const member = await t.newUser();
      const shop = await createShop(t.app, owner);
      await addMember(t.app, shop.id, member.id, 'ADMIN');
      await t
        .as(owner)
        .delete(`/api/shops/${shop.id}/members/${member.id}`)
        .expect(204);

      await cache.set(shop.id, member.id, { role: 'ADMIN', status: 'ACTIVE' }); // the delete-then-repopulate race
      for (const p of SENSITIVE_PERMISSIONS)
        expect(
          (
            await t
              .as(member)
              .get(probe(p))
              .set('X-Shop-Id', shop.id)
              .expect(404)
          ).body.code,
        ).toBe('shop_not_found');
      await t
        .as(member)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(200);

      t.clock.advance(14_000);
      await t
        .as(member)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(200);
      t.clock.advance(2_000);
      await t
        .as(member)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(404);
    });

    it('a non-member is cached negatively for 10 s only', async () => {
      const owner = await t.newUser();
      const later = await t.newUser();
      const shop = await createShop(t.app, owner);
      await t
        .as(later)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(404);
      expect(await cache.get(shop.id, later.id)).toEqual({
        state: 'hit',
        value: null,
      });
      await addMember(t.app, shop.id, later.id, 'STAFF'); // a writer that forgot to invalidate
      await t
        .as(later)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(404);
      t.clock.advance(11_000);
      await t
        .as(later)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(200);
    });

    it('with the cache store unreachable, requests are served from the database and a fallback counter increases', async () => {
      const owner = await t.newUser();
      const stranger = await t.newUser();
      const shop = await createShop(t.app, owner);
      const redis = t.app.get(RedisService).client;
      jest.spyOn(redis, 'get').mockRejectedValue(new Error('redis is down'));
      jest.spyOn(redis, 'multi').mockImplementation(() => {
        throw new Error('redis is down');
      });
      const before =
        MetricsRegistry.value('tenancy_authz_cache_total', {
          result: 'fallback',
        }) ?? 0;
      await t
        .as(owner)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(200);
      await t
        .as(stranger)
        .get(probe('products.read'))
        .set('X-Shop-Id', shop.id)
        .expect(404);
      const after =
        MetricsRegistry.value('tenancy_authz_cache_total', {
          result: 'fallback',
        }) ?? 0;
      expect(after - before).toBe(2);
      jest.restoreAllMocks();
    });
  });

  describe('S03 AS-14: the shop and the request travel with the work', () => {
    it('puts shopId and requestId in the request context, and the events of the request carry the shop', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const res = await t
        .as(owner)
        .get(probe('shop.read'))
        .set('X-Shop-Id', shop.id)
        .expect(200);
      expect(res.body.contextShopId).toBe(shop.id);
      expect(res.body.contextRequestId).toEqual(expect.any(String));

      await t
        .as(owner)
        .patch(`/api/shops/${shop.id}`)
        .send({ name: 'Traced' })
        .expect(200);
      const events = await outboxRowsFor(t.app, shop.id);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.aggregateId).toBe(shop.id);
        expect(e.payload).toMatchObject({ payload: { shopId: shop.id } });
      }
    });

    it('writes no token, address or secret to the log while it serves a mutation', async () => {
      const owner = await t.newUser();
      const shop = await createShop(t.app, owner);
      const lines: string[] = [];
      const capture = (...args: unknown[]) =>
        void lines.push(JSON.stringify(args));
      jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(capture);
      await t
        .as(owner)
        .patch(`/api/shops/${shop.id}`)
        .send({ name: 'Quiet' })
        .expect(200);
      await t
        .as(owner)
        .post(`/api/shops/${shop.id}/invites`)
        .send({ email: 'secret.person@example.com', role: 'STAFF' })
        .expect(201);
      jest.restoreAllMocks();
      const task = (await outboxRowsFor(t.app, shop.id)).find(
        (e) => e.kind === 'task',
      )!;
      const token = (task.payload as { body: { token: string } }).body.token;
      expect(token).toHaveLength(32);
      const text = lines.join('\n');
      expect(text).not.toContain('secret.person@example.com');
      expect(text).not.toContain(token);
      expect(text).not.toContain(owner.bearer.slice(7, 40));
    });
  });

  describe('S03 AS-15: ids of another shop under this shop path', () => {
    it('answers invite_not_found and member_not_found and leaves the other shop untouched', async () => {
      const mine = await t.newUser();
      const stranger = await t.newUser();
      const shopA = await createShop(t.app, mine);
      const shopB = await createShop(t.app, stranger);
      const { invite } = await createInvite(t.app, shopB.id, {
        email: 'b@example.com',
        invitedBy: stranger.id,
      });
      const beforeInvites = await sql(`SELECT * FROM "ShopInvite"`);
      const beforeMembers = await sql(
        `SELECT * FROM "ShopMembership" ORDER BY "shopId","userId"`,
      );

      const resend = await t
        .as(mine)
        .post(`/api/shops/${shopA.id}/invites/${invite.id}/resend`)
        .expect(404);
      expect(resend.body.code).toBe('invite_not_found');
      const revoke = await t
        .as(mine)
        .delete(`/api/shops/${shopA.id}/invites/${invite.id}`)
        .expect(404);
      expect(revoke.body.code).toBe('invite_not_found');
      const patch = await t
        .as(mine)
        .patch(`/api/shops/${shopA.id}/members/${stranger.id}`)
        .send({ role: 'VIEWER' })
        .expect(404);
      expect(patch.body.code).toBe('member_not_found');
      const remove = await t
        .as(mine)
        .delete(`/api/shops/${shopA.id}/members/${stranger.id}`)
        .expect(404);
      expect(remove.body.code).toBe('member_not_found');

      expect(await sql(`SELECT * FROM "ShopInvite"`)).toEqual(beforeInvites);
      expect(
        await sql(`SELECT * FROM "ShopMembership" ORDER BY "shopId","userId"`),
      ).toEqual(beforeMembers);
    });
  });
});
