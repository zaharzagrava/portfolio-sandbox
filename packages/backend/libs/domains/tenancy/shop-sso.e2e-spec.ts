import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { shopSsoConfigSchema } from '@marketplace-sandbox/contracts';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { FakeOidcProvider } from '@app/test/fakes/fake-oidc-provider';
import { OidcProviderRegistry, SecretBox } from '@app/domains/identity';
import { OIDC_NET_OPTIONS } from '../identity/testing/oidc-net';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';
import { ShopSsoService } from './application/shop-sso.service';
import { TENANCY_NET_OPTIONS } from './domain/ports';

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

describe('Company sign-in per shop: configuration, resolver and login', () => {
  let provider: FakeOidcProvider;
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let registry: OidcProviderRegistry;
  let box: SecretBox;
  const invalidated: string[] = [];
  const savedBase = process.env.AUTH_REDIRECT_BASE_URL;

  const SECRET = 'idp-client-secret-1';
  const body = (over: Record<string, unknown> = {}) => ({
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: SECRET,
    ...over,
  });
  const row = async (shopId: string) =>
    (
      await sequelize.query<{
        issuer: string;
        clientId: string;
        clientSecretEnc: string;
        defaultRole: string;
        enabled: boolean;
      }>(`SELECT * FROM "ShopSsoConfig" WHERE "shopId" = $1`, {
        bind: [shopId],
        type: QueryTypes.SELECT,
      })
    )[0];
  /** An owner with a shop; the shop id is the path the routes use. */
  const ownedShop = async (options: Parameters<typeof createShop>[2] = {}) => {
    const owner = await t.newUser();
    const shop = await createShop(t.app, owner, options);
    return { owner, shop, url: `/api/shops/${shop.id}/sso` };
  };

  beforeAll(async () => {
    provider = await FakeOidcProvider.start();
    process.env.AUTH_REDIRECT_BASE_URL = 'http://localhost:8400';
    const net = {
      allowHttpHosts: [provider.host],
      allowPrivateHosts: [provider.host],
    };
    t = await createTenancyApp({
      overrides: [
        { provide: OIDC_NET_OPTIONS, useValue: net },
        { provide: TENANCY_NET_OPTIONS, useValue: net },
      ],
    });
    sequelize = t.app.get(Sequelize);
    registry = t.app.get(OidcProviderRegistry);
    box = t.app.get(SecretBox);
    registry.onInvalidate((id) => invalidated.push(id));
  });
  afterAll(async () => {
    await t.close();
    await provider.stop();
    if (savedBase === undefined) delete process.env.AUTH_REDIRECT_BASE_URL;
    else process.env.AUTH_REDIRECT_BASE_URL = savedBase;
  });
  beforeEach(async () => {
    await t.reset();
    provider.reset();
    invalidated.length = 0;
  });

  it('S03 AS-40: the owner configures the provider; the secret is sealed with the shop context and the registry is told after commit', async () => {
    const { owner, shop, url } = await ownedShop();
    const res = await t.as(owner).put(url).send(body()).expect(200);
    const parsed = shopSsoConfigSchema.parse(res.body);
    expect(parsed).toMatchObject({
      providerId: `shop:${shop.id}`,
      issuer: provider.issuer,
      clientId: provider.clientId,
      secretSet: true,
      defaultRole: 'VIEWER',
      enabled: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    const stored = await row(shop.id);
    expect(stored.clientSecretEnc).not.toContain(SECRET);
    expect(stored.clientSecretEnc.startsWith('v2.')).toBe(true);
    expect(box.open(stored.clientSecretEnc, `shop-sso:${shop.id}`)).toBe(
      SECRET,
    );
    expect(() =>
      box.open(stored.clientSecretEnc, 'shop-sso:another-shop'),
    ).toThrow();
    expect(invalidated).toEqual([`shop:${shop.id}`]);
  });

  it('S03 AS-40: an admin may not configure the provider (403) and nothing changes', async () => {
    const { shop, url } = await ownedShop();
    const admin = await t.newUser();
    await addMember(t.app, shop.id, admin.id, 'ADMIN');
    await t.as(admin).put(url).send(body()).expect(403);
    expect(await row(shop.id)).toBeUndefined();
    expect(invalidated).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });

  it('S03 AS-41: the issuer must be https, public, reachable and name itself; the other fields are bounded', async () => {
    const { owner, shop, url } = await ownedShop();
    const put = (over: Record<string, unknown>) =>
      t.as(owner).put(url).send(body(over));

    const plain = await put({ issuer: 'http://idp.example.com' }).expect(422);
    expect(plain.body.code).toBe('sso_issuer_invalid');
    expect(plain.body.detail).toContain('https');
    for (const issuer of [
      'https://169.254.169.254',
      'https://10.0.0.5',
      'not a url',
      'https://user:pw@idp.example.com',
    ])
      expect((await put({ issuer }).expect(422)).body.code).toBe(
        'sso_issuer_invalid',
      );

    provider.faults.discovery = 'issuer-mismatch';
    expect((await put({}).expect(422)).body.code).toBe('sso_issuer_mismatch');
    provider.faults.discovery = 'status-500';
    expect((await put({}).expect(422)).body.code).toBe(
      'sso_issuer_unreachable',
    );
    provider.faults.discovery = 'hang';
    const started = Date.now();
    expect((await put({}).expect(422)).body.code).toBe(
      'sso_issuer_unreachable',
    );
    expect(Date.now() - started).toBeLessThan(6000);
    provider.faults = {};

    await put({ defaultRole: 'ADMIN' }).expect(400);
    await put({ defaultRole: 'OWNER' }).expect(400);
    await put({ clientSecret: 'x'.repeat(513) }).expect(400);
    await put({ clientId: '' }).expect(400);
    await put({ extra: true }).expect(400);
    expect(await row(shop.id)).toBeUndefined();
    expect(invalidated).toEqual([]);

    await put({ defaultRole: 'STAFF' }).expect(200);
    expect((await row(shop.id)).defaultRole).toBe('STAFF');
  });

  it('S03 AS-41: the first configuration needs a secret', async () => {
    const { owner, url } = await ownedShop();
    await t
      .as(owner)
      .put(url)
      .send(body({ clientSecret: undefined }))
      .expect(400);
  });

  it('S03 AS-42: an update without a secret keeps it, one with a secret replaces it, a replay is the same result', async () => {
    const { owner, shop, url } = await ownedShop();
    const first = await t.as(owner).put(url).send(body()).expect(200);
    const sealedBefore = (await row(shop.id)).clientSecretEnc;

    const keep = await t
      .as(owner)
      .put(url)
      .send(body({ clientSecret: undefined, clientId: 'renamed' }))
      .expect(200);
    expect(keep.body.clientId).toBe('renamed');
    const kept = await row(shop.id);
    expect(box.open(kept.clientSecretEnc, `shop-sso:${shop.id}`)).toBe(SECRET);

    await t
      .as(owner)
      .put(url)
      .send(body({ clientSecret: 'second-secret' }))
      .expect(200);
    const replaced = await row(shop.id);
    expect(replaced.clientSecretEnc).not.toBe(sealedBefore);
    expect(box.open(replaced.clientSecretEnc, `shop-sso:${shop.id}`)).toBe(
      'second-secret',
    );

    const replayA = await t.as(owner).put(url).send(body()).expect(200);
    const replayB = await t.as(owner).put(url).send(body()).expect(200);
    expect({ ...replayB.body, updatedAt: 0 }).toEqual({
      ...replayA.body,
      updatedAt: 0,
    });
    expect(first.body.providerId).toBe(replayB.body.providerId);
    expect(
      await sequelize.query(`SELECT 1 FROM "ShopSsoConfig"`, {
        type: QueryTypes.SELECT,
      }),
    ).toHaveLength(1);
  });

  it('S03 AS-43: the configuration is readable without its secret; 404 sso_not_configured before it exists', async () => {
    const { owner, shop, url } = await ownedShop();
    const none = await t.as(owner).get(url).expect(404);
    expect(none.body.code).toBe('sso_not_configured');
    await t.as(owner).put(url).send(body()).expect(200);
    const res = await t.as(owner).get(url).expect(200);
    expect(shopSsoConfigSchema.parse(res.body).providerId).toBe(
      `shop:${shop.id}`,
    );
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain('v2.');
    const admin = await t.newUser();
    await addMember(t.app, shop.id, admin.id, 'ADMIN');
    await t.as(admin).get(url).expect(403);
  });

  it('S03 AS-44: deleting removes the row and the provider; a repeat is 204', async () => {
    const { owner, shop, url } = await ownedShop();
    await t.as(owner).put(url).send(body()).expect(200);
    expect(await registry.resolve(`shop:${shop.id}`)).toBeDefined();
    invalidated.length = 0;

    await t.as(owner).delete(url).expect(204);
    expect(await row(shop.id)).toBeUndefined();
    expect(invalidated).toEqual([`shop:${shop.id}`]);
    expect(await registry.resolve(`shop:${shop.id}`)).toBeUndefined();
    await t.as(owner).delete(url).expect(204);
    await t.as(owner).get(url).expect(404);
  });

  it('S03 AS-45: the resolver hands the registry the plain secret; a disabled or suspended shop is unknown', async () => {
    const { owner, shop, url } = await ownedShop();
    await t.as(owner).put(url).send(body()).expect(200);
    const resolved = await registry.resolve(`shop:${shop.id}`);
    expect(resolved?.settings).toMatchObject({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: SECRET,
    });

    await sequelize.query(
      `UPDATE "ShopSsoConfig" SET "enabled" = false WHERE "shopId" = $1`,
      { bind: [shop.id] },
    );
    expect(await registry.resolve(`shop:${shop.id}`)).toBeUndefined();
    await sequelize.query(
      `UPDATE "ShopSsoConfig" SET "enabled" = true WHERE "shopId" = $1`,
      { bind: [shop.id] },
    );
    await sequelize.query(
      `UPDATE "Shop" SET "status" = 'SUSPENDED' WHERE "id" = $1`,
      { bind: [shop.id] },
    );
    expect(await registry.resolve(`shop:${shop.id}`)).toBeUndefined();
    expect(
      await registry.resolve(
        `shop:${'0'.repeat(8)}-0000-4000-8000-000000000000`,
      ),
    ).toBeUndefined();
  });

  it('S03 AS-45: a secret sealed before contexts existed still opens, and a re-seal binds it to the shop', async () => {
    const { shop } = await ownedShop();
    await sequelize.query(
      `INSERT INTO "ShopSsoConfig" ("shopId","issuer","clientId","clientSecretEnc","enabled","updatedAt")
       VALUES ($1,$2,'legacy',$3,true,now())`,
      { bind: [shop.id, provider.issuer, box.seal('legacy-secret')] },
    );
    const resolved = await registry.resolve(`shop:${shop.id}`);
    expect(resolved?.settings.clientSecret).toBe('legacy-secret');

    const reseal = t.app.get(ShopSsoService);
    expect(await reseal.resealLegacySecrets(200)).toBe(1);
    expect(await reseal.resealLegacySecrets(200)).toBe(0);
    const stored = await row(shop.id);
    expect(stored.clientSecretEnc.startsWith('v2.')).toBe(true);
    expect(box.open(stored.clientSecretEnc, `shop-sso:${shop.id}`)).toBe(
      'legacy-secret',
    );
    expect(
      (await registry.resolve(`shop:${shop.id}`))?.settings.clientSecret,
    ).toBe('legacy-secret');
  });

  it('S03 AS-50: a member of the company signs in through the shop provider; the new account has no e-mail and is never linked by address', async () => {
    const { owner, shop, url } = await ownedShop();
    await t.as(owner).put(url).send(body()).expect(200);
    const victim = await t.newUser({ email: 'victim-50@example.com' });

    const start = await t
      .http()
      .post(`/api/auth/oidc/shop:${shop.id}/start`)
      .send({})
      .expect(200);
    const flowLine = (
      (start.headers['set-cookie'] ?? []) as unknown as string[]
    ).find((l) => l.startsWith('__Host-oidc-flow='))!;
    const flowCookie = flowLine.split(';')[0].slice('__Host-oidc-flow='.length);
    const back = provider.approve(start.body.authorizationUrl as string, {
      sub: 'company-subject-1',
      email: 'victim-50@example.com',
      email_verified: true,
    });
    const res = await t
      .http()
      .get(`/api/auth/oidc/shop:${shop.id}/callback${new URL(back).search}`)
      .set('Cookie', `__Host-oidc-flow=${flowCookie}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain('error=');

    const users = await sequelize.query<{ id: string; email: string | null }>(
      `SELECT "id","email" FROM "User" WHERE "id" <> $1 AND "id" <> $2`,
      { bind: [owner.id, victim.id], type: QueryTypes.SELECT },
    );
    expect(users).toHaveLength(1);
    expect(users[0].email).toBeNull();
    const links = await sequelize.query<{ userId: string; provider: string }>(
      `SELECT "userId","provider" FROM "FederatedIdentity"`,
      { type: QueryTypes.SELECT },
    );
    expect(links).toEqual([
      { userId: users[0].id, provider: `shop:${shop.id}` },
    ]);
  });
});
