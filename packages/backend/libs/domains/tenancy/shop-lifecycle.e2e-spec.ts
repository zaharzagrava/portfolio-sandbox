import { getModelToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  pageSchema,
  shopListItemSchema,
  shopSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { UserModel as User } from '@app/domains/identity';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

const listSchema = pageSchema(shopListItemSchema);

describe('Shop lifecycle', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  const rows = <T extends object>(
    sql: string,
    replacements: Record<string, unknown> = {},
  ) => sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-01: creating a shop returns the contract body and persists shop, owner membership, directory entry and events, and writes nothing to the user', async () => {
    const owner = await t.newUser();
    const before = await t.app
      .get<typeof User>(getModelToken(User))
      .findByPk(owner.id, { raw: true });

    const res = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Acme Goods', slug: 'acme-goods' })
      .expect(201);

    const body = shopSchema.parse(res.body);
    expect(body).toMatchObject({
      name: 'Acme Goods',
      slug: 'acme-goods',
      plan: 'STARTER',
      status: 'ACTIVE',
      verificationStatus: 'UNVERIFIED',
      payoutsEnabled: false,
      region: 'eu-central-1',
      shopVersion: 1,
      myRole: 'OWNER',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/stripe/i);

    const shop = await rows<{ id: string; slug: string }>(
      `SELECT "id","slug" FROM "Shop" WHERE "id" = :id`,
      { id: body.id },
    );
    expect(shop).toHaveLength(1);
    const members = await rows<{
      userId: string;
      role: string;
      source: string;
    }>(
      `SELECT "userId","role","source" FROM "ShopMembership" WHERE "shopId" = :id`,
      { id: body.id },
    );
    expect(members).toEqual([
      { userId: owner.id, role: 'OWNER', source: 'owner' },
    ]);
    const directory = await rows<{ cell: string; region: string }>(
      `SELECT "cell","region" FROM "ShopDirectory" WHERE "shopId" = :id`,
      { id: body.id },
    );
    expect(directory).toEqual([{ cell: 'pooled', region: 'eu-central-1' }]);
    const history = await rows<{ from: string | null; to: string }>(
      `SELECT "from","to" FROM "ShopStatusHistory" WHERE "shopId" = :id`,
      { id: body.id },
    );
    expect(history).toEqual([{ from: null, to: 'ACTIVE' }]);

    const events = await outboxRowsFor(t.app, body.id);
    expect(events.map((e) => e.type).sort()).toEqual([
      'tenancy.member_added',
      'tenancy.shop_created',
    ]);
    const created = events.find((e) => e.type === 'tenancy.shop_created')!;
    expect(created.topic).toBe('tenancy.events');
    expect(created.payload).toMatchObject({
      aggregateId: body.id,
      version: 1,
      payload: {
        shopId: body.id,
        ownerId: owner.id,
        name: 'Acme Goods',
        slug: 'acme-goods',
        plan: 'STARTER',
        region: 'eu-central-1',
        shopVersion: 1,
      },
    });

    // The principal's account is untouched: promotion to SELLER is identity's consumer of `shop_created`.
    const after = await t.app
      .get<typeof User>(getModelToken(User))
      .findByPk(owner.id, { raw: true });
    expect(after).toEqual(before);
    expect(after!.role).toBe('USER');
  });

  it.each([
    ['name too short', { name: 'A', slug: 'good-slug' }],
    ['name too long', { name: 'x'.repeat(81), slug: 'good-slug' }],
    ['name missing', { slug: 'good-slug' }],
    ['slug too short', { name: 'Fine', slug: 'ab' }],
    ['slug too long', { name: 'Fine', slug: 'a'.repeat(41) }],
    ['slug upper case', { name: 'Fine', slug: 'Upper' }],
    ['slug starts with a hyphen', { name: 'Fine', slug: '-abc' }],
    ['slug ends with a hyphen', { name: 'Fine', slug: 'abc-' }],
    ['slug with a space', { name: 'Fine', slug: 'a b c' }],
    ['unknown field', { name: 'Fine', slug: 'good-slug', ownerId: 'x' }],
    ['name not a string', { name: 42, slug: 'good-slug' }],
  ])(
    'S03 AS-02: %s -> 400 validation_failed and nothing is created',
    async (_, body) => {
      const user = await t.newUser();
      const res = await t.as(user).post('/api/shops').send(body).expect(400);
      expect(res.body.code).toBe('validation_failed');
      expect(await rows(`SELECT 1 FROM "Shop"`)).toHaveLength(0);
    },
  );

  it('S03 AS-02: a region outside the allowed list is 422 region_not_allowed and an allowed one is stored', async () => {
    const user = await t.newUser();
    const bad = await t
      .as(user)
      .post('/api/shops')
      .send({ name: 'Fine', slug: 'fine-shop', region: 'mars-1' })
      .expect(422);
    expect(bad.body.code).toBe('region_not_allowed');
    expect(await rows(`SELECT 1 FROM "Shop"`)).toHaveLength(0);

    const ok = await t
      .as(user)
      .post('/api/shops')
      .send({ name: 'Fine', slug: 'fine-shop', region: 'us-east-1' })
      .expect(201);
    expect(shopSchema.parse(ok.body).region).toBe('us-east-1');
  });

  it('S03 AS-03: reserved slugs are 422 slug_reserved, a taken slug is 409 slug_taken', async () => {
    const user = await t.newUser();
    for (const slug of ['admin', 'seller-123', 'my-sandbox', 'deleted-abc']) {
      const res = await t
        .as(user)
        .post('/api/shops')
        .send({ name: 'Fine', slug })
        .expect(422);
      expect(res.body.code).toBe('slug_reserved');
    }
    await t
      .as(user)
      .post('/api/shops')
      .send({ name: 'One', slug: 'taken-one' })
      .expect(201);
    const other = await t.newUser();
    const taken = await t
      .as(other)
      .post('/api/shops')
      .send({ name: 'Two', slug: 'taken-one' })
      .expect(409);
    expect(taken.body.code).toBe('slug_taken');
    expect(await rows(`SELECT 1 FROM "Shop"`)).toHaveLength(1);
  });

  it('S03 AS-03: two simultaneous creations of the same slug: exactly one wins and leaves one shop', async () => {
    const [a, b] = await Promise.all([t.newUser(), t.newUser()]);
    const results = await Promise.all(
      [a, b].map((u) =>
        t.as(u).post('/api/shops').send({ name: 'Race', slug: 'race-slug' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('slug_taken');
    expect(
      await rows(`SELECT 1 FROM "Shop" WHERE "slug" = 'race-slug'`),
    ).toHaveLength(1);
    expect(await rows(`SELECT 1 FROM "ShopMembership"`)).toHaveLength(1);
  });

  it('S03 AS-04: the eleventh owned shop is 409 shop_limit_reached', async () => {
    const owner = await t.newUser();
    for (let i = 0; i < 10; i++) await createShop(t.app, owner);
    const res = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Eleven', slug: 'shop-eleven' })
      .expect(409);
    expect(res.body.code).toBe('shop_limit_reached');
    expect(await rows(`SELECT 1 FROM "Shop"`)).toHaveLength(10);
  });

  it('S03 AS-04: shops owned as ADMIN or in other roles do not count, and two simultaneous creations at nine leave ten', async () => {
    const owner = await t.newUser();
    const stranger = await t.newUser();
    for (let i = 0; i < 9; i++) await createShop(t.app, owner);
    for (let i = 0; i < 3; i++) {
      const s = await createShop(t.app, stranger);
      await addMember(t.app, s.id, owner.id, 'ADMIN');
    }
    const results = await Promise.all(
      ['race-a', 'race-b'].map((slug) =>
        t.as(owner).post('/api/shops').send({ name: 'Racing', slug }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'shop_limit_reached',
    );
    const owned = await rows<{ n: string }>(
      `SELECT count(*) AS n FROM "ShopMembership" WHERE "userId" = :id AND "role" = 'OWNER'`,
      { id: owner.id },
    );
    expect(Number(owned[0].n)).toBe(10);
  });

  it('S03 FR-090: the sixth creation in an hour by one user is 429 with Retry-After, another user is unaffected', async () => {
    const user = await t.newUser();
    for (let i = 0; i < 5; i++)
      await t
        .as(user)
        .post('/api/shops')
        .send({ name: `Shop ${i}`, slug: `limit-shop-${i}` })
        .expect(201);
    const limited = await t
      .as(user)
      .post('/api/shops')
      .send({ name: 'Six', slug: 'limit-shop-6' })
      .expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.body.code).toBe('rate_limited');
    expect(
      await rows(`SELECT 1 FROM "Shop" WHERE "slug" = 'limit-shop-6'`),
    ).toHaveLength(0);

    const other = await t.newUser();
    await t
      .as(other)
      .post('/api/shops')
      .send({ name: 'Other', slug: 'other-shop' })
      .expect(201);
  });

  it('S03 AS-06: a member reads the shop with myRole and myPermissions, parsed by the contract', async () => {
    const owner = await t.newUser();
    const viewer = await t.newUser();
    const shop = await createShop(t.app, owner, {
      name: 'Readable',
      slug: 'readable',
    });
    await addMember(t.app, shop.id, viewer.id, 'VIEWER');

    const asOwner = await t.as(owner).get(`/api/shops/${shop.id}`).expect(200);
    const ownerBody = shopSchema.parse(asOwner.body);
    expect(ownerBody).toMatchObject({
      id: shop.id,
      slug: 'readable',
      myRole: 'OWNER',
    });
    expect(ownerBody.myPermissions).toEqual(
      expect.arrayContaining(['shop.delete', 'sso.manage']),
    );

    const asViewer = await t
      .as(viewer)
      .get(`/api/shops/${shop.id}`)
      .expect(200);
    const viewerBody = shopSchema.parse(asViewer.body);
    expect(viewerBody.myRole).toBe('VIEWER');
    expect(viewerBody.myPermissions).toContain('shop.read');
    expect(viewerBody.myPermissions).not.toContain('payouts.read');
    expect(JSON.stringify(asViewer.body)).not.toMatch(/stripe/i);
  });

  it('S03 AS-07: mine pages by cursor in membership order, rejects a tampered cursor and a limit above 100, and hides sandbox shops', async () => {
    const user = await t.newUser();
    const shops: Awaited<ReturnType<typeof createShop>>[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await createShop(t.app, null, {
        name: `Mine ${i}`,
        slug: `mine-${i}`,
      });
      await addMember(
        t.app,
        s.id,
        user.id,
        'STAFF',
        'invite',
        new Date(Date.UTC(2026, 0, 1 + i)),
      );
      shops.push(s);
    }
    const sandbox = await createShop(t.app, null, {
      slug: 'mine-0-sandbox-x',
      sandboxOf: shops[0].id,
    });
    await addMember(
      t.app,
      sandbox.id,
      user.id,
      'OWNER',
      'owner',
      new Date(Date.UTC(2026, 0, 9)),
    );

    const first = await t.as(user).get('/api/shops/mine?limit=2').expect(200);
    const page1 = listSchema.parse(first.body);
    expect(page1.items.map((i) => i.slug)).toEqual(['mine-0', 'mine-1']);
    expect(page1.items[0]).toMatchObject({
      role: 'STAFF',
      plan: 'STARTER',
      status: 'ACTIVE',
    });
    expect(page1.nextCursor).toEqual(expect.any(String));

    const second = await t
      .as(user)
      .get(`/api/shops/mine?limit=2&cursor=${page1.nextCursor}`)
      .expect(200);
    const page2 = listSchema.parse(second.body);
    expect(page2.items.map((i) => i.slug)).toEqual(['mine-2']);
    expect(page2.nextCursor).toBeNull();

    for (const query of [
      'cursor=not-a-cursor',
      'cursor=' + Buffer.from('["x","y"]').toString('base64url'),
      'limit=101',
      'limit=0',
      'limit=abc',
    ])
      expect(
        (await t.as(user).get(`/api/shops/mine?${query}`).expect(400)).body
          .code,
      ).toBe('validation_failed');
  });

  it('S03 AS-08: an admin renames the shop; shopVersion and the event move; slug and plan cannot be sent', async () => {
    const owner = await t.newUser();
    const admin = await t.newUser();
    const staff = await t.newUser();
    const shop = await createShop(t.app, owner, { slug: 'rename-me' });
    await addMember(t.app, shop.id, admin.id, 'ADMIN');
    await addMember(t.app, shop.id, staff.id, 'STAFF');

    const res = await t
      .as(admin)
      .patch(`/api/shops/${shop.id}`)
      .send({ name: 'New Name' })
      .expect(200);
    expect(shopSchema.parse(res.body)).toMatchObject({
      name: 'New Name',
      slug: 'rename-me',
      shopVersion: 2,
    });
    const events = (await outboxRowsFor(t.app, shop.id)).filter(
      (e) => e.type === 'tenancy.shop_updated',
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      payload: {
        shopId: shop.id,
        name: 'New Name',
        slug: 'rename-me',
        shopVersion: 2,
      },
    });

    for (const body of [
      { slug: 'other' },
      { plan: 'PRO' },
      { name: 'X' },
      {},
      { name: 'Ok name', status: 'SUSPENDED' },
    ])
      expect(
        (
          await t
            .as(admin)
            .patch(`/api/shops/${shop.id}`)
            .send(body)
            .expect(400)
        ).body.code,
      ).toBe('validation_failed');

    const denied = await t
      .as(staff)
      .patch(`/api/shops/${shop.id}`)
      .send({ name: 'Staff Rename' })
      .expect(403);
    expect(denied.body.code).toBe('permission_denied');
    expect(
      await rows<{ name: string }>(
        `SELECT "name" FROM "Shop" WHERE "id" = :id`,
        { id: shop.id },
      ),
    ).toEqual([{ name: 'New Name' }]);
  });

  it('S03 FR-090: the 121st mutation in a minute on one shop is 429 with Retry-After, another shop is unaffected', async () => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner);
    const other = await createShop(t.app, owner);
    let last = 0;
    for (let i = 0; i < 120; i++)
      last = (
        await t
          .as(owner)
          .patch(`/api/shops/${shop.id}`)
          .send({ name: `Name ${i}` })
      ).status;
    expect(last).toBe(200);
    const limited = await t
      .as(owner)
      .patch(`/api/shops/${shop.id}`)
      .send({ name: 'Name 121' })
      .expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
    await t
      .as(owner)
      .patch(`/api/shops/${other.id}`)
      .send({ name: 'Unaffected' })
      .expect(200);
  });
});
