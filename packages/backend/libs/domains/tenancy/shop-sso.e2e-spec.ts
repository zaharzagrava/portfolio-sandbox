import { Sequelize } from 'sequelize-typescript';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

describe('Company sign-in per shop: public lookup', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;

  const configure = (shopId: string, enabled: boolean) =>
    sequelize.query(
      `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc","enabled","updatedAt")
       VALUES ($1,'https://idp.example.com','client','sealed',$2,now())`,
      { bind: [shopId, enabled] },
    );
  const lookup = (slug: string) =>
    t.http().get(`/api/shops/by-slug/${slug}/sso`);

  beforeAll(async () => {
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  it('S03 AS-46: anonymous lookup by slug answers {providerId, displayName} for SSO, an identical 404 otherwise', async () => {
    const owner = await t.newUser();
    const sso = await createShop(t.app, owner, { name: 'Acme GmbH' });
    const disabled = await createShop(t.app, owner);
    const suspended = await createShop(t.app, owner, { status: 'SUSPENDED' });
    const plain = await createShop(t.app, owner);
    await configure(sso.id, true);
    await configure(disabled.id, false);
    await configure(suspended.id, true);

    const ok = await lookup(sso.slug).expect(200);
    expect(ok.body).toEqual({
      providerId: `shop:${sso.id}`,
      displayName: 'Acme GmbH',
    });

    const misses = [
      await lookup('no-such-shop-slug').expect(404),
      await lookup(disabled.slug).expect(404),
      await lookup(suspended.slug).expect(404),
      await lookup(plain.slug).expect(404),
    ];
    // Only the request's own `instance` and `requestId` may differ.
    const shape = (body: Record<string, unknown>) => ({
      ...body,
      instance: undefined,
      requestId: undefined,
    });
    for (const miss of misses)
      expect(shape(miss.body)).toEqual(shape(misses[0].body));
    expect(JSON.stringify(misses[0].body)).not.toContain('issuer');
  });

  it('S03 AS-46: the 31st lookup in a minute from one IP is 429', async () => {
    let last = 0;
    for (let i = 0; i < 30; i++) last = (await lookup('nobody-here')).status;
    expect(last).toBe(404);
    const limited = await lookup('nobody-here').expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
