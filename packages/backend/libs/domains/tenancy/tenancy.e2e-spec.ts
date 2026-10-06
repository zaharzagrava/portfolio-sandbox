import { QueryTypes } from 'sequelize';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getModelToken } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { ProductModule } from '@app/domains/catalog';
import ShopInvite from './infra/models/shop-invite.model';
import ShopMembership from './infra/models/shop-membership.model';
import { TenancyModule } from './tenancy.module';
import { ShopService } from './application/shop.service';

/** SD-02 against real Postgres (RLS) + Redis + DynamoDB (sessions). */
describe('Multi-tenant shops (e2e)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let shops: ShopService;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([TenancyModule, ProductModule, RateLimitModule, CacheModule, SeedsModule], {
      stores: ['redis', 'dynamo'],
    });
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seedsService = app.get(SeedsService);
    shops = app.get(ShopService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
  });

  /** Registers a user through the real auth flow and returns a bearer header + id. */
  const user = async () => {
    const email = `u-${v4()}@mail.com`;
    const body = (await http().post('/api/auth/register').send({ email, password: 'password-1234' }).expect(201)).body;
    return { id: body.user.id as string, email, refreshToken: body.refreshToken as string, auth: { Authorization: `Bearer ${body.accessToken.token}` } };
  };

  const shopOf = async (owner: { auth: Record<string, string> }) =>
    (await http().post('/api/shops').set(owner.auth).send({ name: 'Acme', slug: `acme-${v4().slice(0, 8)}` }).expect(201)).body.id as string;

  it('BOLA: a member of shop A gets 404 (not 403) for shop B and its members', async () => {
    const alice = await user();
    const bob = await user();
    const shopA = await shopOf(alice);
    const shopB = await shopOf(bob);

    await http().get(`/api/shops/${shopA}`).set(alice.auth).expect(200);
    await http().get(`/api/shops/${shopB}`).set(alice.auth).expect(404);
    await http().get(`/api/shops/${shopB}/members`).set(alice.auth).expect(404);
    await http().post(`/api/products/shops/${shopB}`).set(alice.auth).send({ title: 'x', description: 'x', brand: 'x', category: 'x', price: 1 }).expect(404);
  });

  it('invite → accept → role permissions: VIEWER can read but not write products', async () => {
    const owner = await user();
    const viewer = await user();
    const shopId = await shopOf(owner);

    const { inviteUrl } = (await http().post(`/api/shops/${shopId}/invites`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201)).body;
    const token = inviteUrl.split('/').pop();
    await http().post('/api/shop-invites/accept').set(viewer.auth).send({ token }).expect(201);

    await http().get(`/api/shops/${shopId}`).set(viewer.auth).expect(200);
    await http()
      .post(`/api/products/shops/${shopId}`)
      .set(viewer.auth)
      .send({ title: 'AirPods', description: 'x', brand: 'Apple', category: 'audio', price: 24900 })
      .expect(403);

    // single use
    await http().post('/api/shop-invites/accept').set(viewer.auth).send({ token }).expect(404);
  });

  it('write skew: two owners demoting each other at the same time cannot leave the shop ownerless', async () => {
    const a = await user();
    const b = await user();
    const shopId = await shopOf(a);
    await app.get<typeof ShopMembership>(getModelToken(ShopMembership)).create({ shopId, userId: b.id, role: 'OWNER' });

    const results = await inParallel(2, (i) => shops.changeRole(shopId, i === 0 ? a.id : b.id, 'ADMIN'));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const owners = (await shops.members(shopId)).filter((m) => m.role === 'OWNER');
    expect(owners).toHaveLength(1);
  });

  it('RLS backstop: invites are invisible outside their shop transaction', async () => {
    const owner = await user();
    const shopId = await shopOf(owner);
    await http().post(`/api/shops/${shopId}/invites`).set(owner.auth).send({ email: `x-${v4()}@mail.com`, role: 'STAFF' }).expect(201);

    // Superusers bypass RLS even with FORCE, and the test DB connects as one - so probe the policy as a plain role.
    const inviteModel = app.get<typeof ShopInvite>(getModelToken(ShopInvite));
    const sequelize = inviteModel.sequelize!;
    await sequelize.query(`DO $$ BEGIN CREATE ROLE rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await sequelize.query(`GRANT SELECT ON "ShopInvite" TO rls_probe`);
    const visible = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL ROLE rls_probe', { transaction });
      const [row] = await sequelize.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ShopInvite"`, { type: QueryTypes.SELECT, transaction });
      return row.n;
    });
    expect(visible).toBe(0); // no app.shop_id set → policy filters everything
    expect(await shops.listInvites(shopId)).toHaveLength(1);
  });

  it('membership changes take effect immediately (cache invalidated)', async () => {
    const owner = await user();
    const staff = await user();
    const shopId = await shopOf(owner);
    await app.get<typeof ShopMembership>(getModelToken(ShopMembership)).create({ shopId, userId: staff.id, role: 'STAFF' });

    await http().get(`/api/shops/${shopId}`).set(staff.auth).expect(200); // warms the membership cache
    await http().delete(`/api/shops/${shopId}/members/${staff.id}`).set(owner.auth).expect(204);
    await http().get(`/api/shops/${shopId}`).set(staff.auth).expect(404);
  });

  it('opening a shop makes the owner a SELLER; the next refresh issues a SELLER token', async () => {
    const owner = await user();
    expect((await http().get('/api/auth/me').set(owner.auth).expect(200)).body.role).toBe('USER');

    await shopOf(owner);
    const refreshed = (await http().post('/api/auth/refresh').send({ refreshToken: owner.refreshToken }).expect(200)).body;
    expect(refreshed.user.role).toBe('SELLER');
    const me = await http().get('/api/auth/me').set({ Authorization: `Bearer ${refreshed.accessToken.token}` }).expect(200);
    expect(me.body.role).toBe('SELLER');
    expect((await http().get('/api/shops/mine').set(owner.auth).expect(200)).body).toHaveLength(1);
  });
});
