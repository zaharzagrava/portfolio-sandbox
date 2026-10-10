import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { Sequelize } from 'sequelize-typescript';
import {
  addMember,
  createInvite,
  createShop,
} from '@app/test/utils/tenancy-fixtures';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

const UNKNOWN = '018f0000-0000-7000-8000-000000000000';

describe('Errors of the tenancy domain', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-79: each error is problem+json with its stable code, status and a request id', async () => {
    const owner = await t.newUser();
    const admin = await t.newUser();
    const viewer = await t.newUser();
    const stranger = await t.newUser();
    const shop = await createShop(t.app, owner, {
      plan: 'STARTER',
      slug: 'errors-shop',
    });
    await addMember(t.app, shop.id, admin.id, 'ADMIN');
    await addMember(t.app, shop.id, viewer.id, 'VIEWER');
    const suspended = await createShop(t.app, owner, { status: 'SUSPENDED' });
    const closing = await createShop(t.app, owner, { status: 'DELETING' });
    const full = await createShop(t.app, owner, { plan: 'STARTER' });
    for (let i = 0; i < 4; i++)
      await addMember(t.app, full.id, (await t.newUser()).id, 'VIEWER');
    const { invite, token } = await createInvite(t.app, shop.id, {
      email: 'known@example.com',
      invitedBy: owner.id,
    });
    const accepted = await createInvite(t.app, shop.id, {
      email: 'done@example.com',
      invitedBy: owner.id,
      acceptedAt: new Date(),
    });
    const heavy = await t.newUser();
    for (let i = 0; i < 10; i++) await createShop(t.app, heavy);
    expect(token).toBeDefined();

    const cases: Array<[string, number, () => import('supertest').Test]> = [
      ['invalid_token', 401, () => t.http().get('/api/shops/mine')],
      [
        'validation_failed',
        400,
        () =>
          t.as(owner).post('/api/shops').send({ name: 'A', slug: 'ok-slug' }),
      ],
      [
        'shop_mismatch',
        400,
        () =>
          t.as(owner).get(`/api/shops/${shop.id}`).set('X-Shop-Id', UNKNOWN),
      ],
      [
        'shop_not_found',
        404,
        () => t.as(stranger).get(`/api/shops/${shop.id}`),
      ],
      [
        'permission_denied',
        403,
        () =>
          t.as(viewer).patch(`/api/shops/${shop.id}`).send({ name: 'Nope' }),
      ],
      [
        'insufficient_role',
        403,
        () =>
          t
            .as(admin)
            .patch(`/api/shops/${shop.id}/members/${owner.id}`)
            .send({ role: 'VIEWER' }),
      ],
      [
        'shop_suspended',
        403,
        () =>
          t
            .as(owner)
            .patch(`/api/shops/${suspended.id}`)
            .send({ name: 'Nope' }),
      ],
      [
        'shop_offboarding',
        409,
        () =>
          t.as(owner).patch(`/api/shops/${closing.id}`).send({ name: 'Nope' }),
      ],
      [
        'member_not_found',
        404,
        () =>
          t
            .as(owner)
            .patch(`/api/shops/${shop.id}/members/${stranger.id}`)
            .send({ role: 'STAFF' }),
      ],
      [
        'last_owner',
        409,
        () => t.as(owner).delete(`/api/shops/${shop.id}/members/${owner.id}`),
      ],
      [
        'slug_taken',
        409,
        () =>
          t
            .as(stranger)
            .post('/api/shops')
            .send({ name: 'Dup', slug: 'errors-shop' }),
      ],
      [
        'slug_reserved',
        422,
        () =>
          t
            .as(stranger)
            .post('/api/shops')
            .send({ name: 'Admin', slug: 'admin' }),
      ],
      [
        'region_not_allowed',
        422,
        () =>
          t
            .as(stranger)
            .post('/api/shops')
            .send({ name: 'Far', slug: 'far-away', region: 'moon-1' }),
      ],
      [
        'shop_limit_reached',
        409,
        () =>
          t
            .as(heavy)
            .post('/api/shops')
            .send({ name: 'Eleven', slug: 'eleven-shop' }),
      ],
      [
        'already_member',
        409,
        () =>
          t
            .as(owner)
            .post(`/api/shops/${shop.id}/invites`)
            .send({ email: viewer.email, role: 'STAFF' }),
      ],
      [
        'invite_pending',
        409,
        () =>
          t
            .as(owner)
            .post(`/api/shops/${shop.id}/invites`)
            .send({ email: 'known@example.com', role: 'STAFF' }),
      ],
      [
        'seat_limit_reached',
        409,
        () =>
          t
            .as(owner)
            .post(`/api/shops/${full.id}/invites`)
            .send({ email: 'late@example.com', role: 'STAFF' }),
      ],
      [
        'invite_not_found',
        404,
        () =>
          t
            .as(stranger)
            .post('/api/shop-invites/accept')
            .send({ token: 'unknown' }),
      ],
      [
        'invalid_transition',
        409,
        () =>
          t
            .as(owner)
            .delete(`/api/shops/${shop.id}/invites/${accepted.invite.id}`),
      ],
    ];
    expect(invite.id).toBeDefined();
    for (const [code, status, request] of cases) {
      const res = await request();
      expect([code, res.status]).toEqual([code, status]);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      const body = problemDetailsSchema.parse(res.body);
      expect(body.code).toBe(code);
      expect(body.status).toBe(status);
      expect(JSON.stringify(body)).not.toMatch(/\bstack\b|SELECT |sequelize/i);
    }
  });

  it('S03 AS-79: rate limiting and serialization exhaustion also answer problem+json with Retry-After', async () => {
    const user = await t.newUser();
    for (let i = 0; i < 5; i++)
      await t
        .as(user)
        .post('/api/shops')
        .send({ name: `S${i}x`, slug: `rate-shop-${i}` })
        .expect(201);
    const limited = await t
      .as(user)
      .post('/api/shops')
      .send({ name: 'Six', slug: 'rate-shop-6' })
      .expect(429);
    expect(problemDetailsSchema.parse(limited.body).code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();

    const owner = await t.newUser();
    const member = await t.newUser();
    const shop = await createShop(t.app, owner);
    await addMember(t.app, shop.id, member.id, 'STAFF');
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION tenancy_test_serialize() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced' USING ERRCODE = '40001'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER tenancy_test_serialize BEFORE UPDATE ON "ShopMembership" FOR EACH ROW EXECUTE FUNCTION tenancy_test_serialize();`);
    try {
      const res = await t
        .as(owner)
        .patch(`/api/shops/${shop.id}/members/${member.id}`)
        .send({ role: 'ADMIN' })
        .expect(503);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'serialization_failure',
      );
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await sequelize.query(
        `DROP TRIGGER IF EXISTS tenancy_test_serialize ON "ShopMembership"; DROP FUNCTION IF EXISTS tenancy_test_serialize();`,
      );
    }
  });

  it('S03 AS-79: a database failure answers a generic 500 that shows no SQL, stack, identifier or table', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION tenancy_test_break() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'relation "Secret" violates constraint at SELECT * FROM "User"'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER tenancy_test_break BEFORE UPDATE ON "Shop" FOR EACH ROW EXECUTE FUNCTION tenancy_test_break();`);
    try {
      const res = await t
        .as(owner)
        .patch(`/api/shops/${shop.id}`)
        .send({ name: 'Broken' })
        .expect(500);
      const body = problemDetailsSchema.parse(res.body);
      expect(body.code).toBe('internal_error');
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(
        /SELECT|Secret|relation|constraint|stack|ShopMembership|"Shop"/i,
      );
      expect(
        JSON.stringify({ ...res.body, instance: undefined }),
      ).not.toContain(shop.id); // `instance` is the caller's own URL
    } finally {
      await sequelize.query(
        `DROP TRIGGER IF EXISTS tenancy_test_break ON "Shop"; DROP FUNCTION IF EXISTS tenancy_test_break();`,
      );
    }
  });

  it('S03 AS-79: an unknown field is 400 validation_failed whatever the route', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    const bodies: Array<[string, () => import('supertest').Test]> = [
      [
        'create shop',
        () =>
          t
            .as(owner)
            .post('/api/shops')
            .send({ name: 'Ok name', slug: 'ok-name', extra: true }),
      ],
      [
        'rename shop',
        () =>
          t
            .as(owner)
            .patch(`/api/shops/${shop.id}`)
            .send({ name: 'Ok name', extra: true }),
      ],
      [
        'change role',
        () =>
          t
            .as(owner)
            .patch(`/api/shops/${shop.id}/members/${owner.id}`)
            .send({ role: 'OWNER', extra: true }),
      ],
      [
        'create invite',
        () =>
          t
            .as(owner)
            .post(`/api/shops/${shop.id}/invites`)
            .send({ email: 'a@example.com', role: 'STAFF', extra: true }),
      ],
      [
        'accept invite',
        () =>
          t
            .as(owner)
            .post('/api/shop-invites/accept')
            .send({ token: 'x', extra: true }),
      ],
    ];
    for (const [name, request] of bodies) {
      const res = await request();
      expect([name, res.status, res.body.code]).toEqual([
        name,
        400,
        'validation_failed',
      ]);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'extra' })]),
      );
    }
  });
});
