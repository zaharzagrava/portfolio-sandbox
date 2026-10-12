import https from 'node:https';
import http from 'node:http';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  flushRedis,
  passwordLogin,
  enableSecondFactor,
} from './testing/mfa-fixtures';
import { authStore } from './testing/auth-app';
import {
  OidcTestApp,
  callback,
  createOidcApp,
  setCookies,
  startFlow,
} from './testing/oidc-fixtures';
import {
  OidcProviderRegistry,
  type OidcProviderSettings,
} from './application/oidc-provider-registry';

const SHOP = 'shop:00000000-0000-4000-8000-0000000000a1';
const OTHER_SHOP = 'shop:00000000-0000-4000-8000-0000000000a2';

type Resolver = (id: string) => Promise<OidcProviderSettings | undefined>;

/**
 * The test stack already runs tenancy's real `shop:` resolver, and a prefix can be registered only once. The stand-in
 * domain takes the prefix over through the registry's own map (a test-only seam) so the spec controls the settings.
 */
function standIn(registry: OidcProviderRegistry, resolver: Resolver): void {
  (registry as unknown as { resolvers: Map<string, Resolver> }).resolvers.set(
    'shop:',
    resolver,
  );
}

describe('S02 shop identity providers through the registry', () => {
  let app: OidcTestApp;
  /** What the stand-in domain (tenancy) knows: provider id → settings; `'throw'` makes its resolver fail. */
  const shops = new Map<string, OidcProviderSettings | 'throw'>();

  beforeAll(async () => {
    app = await createOidcApp();
    standIn(app.t.app.get(OidcProviderRegistry), async (id) => {
      const found = shops.get(id);
      if (found === 'throw') throw new Error('database down');
      return found;
    });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await app.t.reset();
    await flushRedis(app.t);
    app.reset();
    shops.clear();
  });

  const settings = (over: Partial<OidcProviderSettings> = {}) => ({
    issuer: app.provider.issuer,
    clientId: app.provider.clientId,
    clientSecret: app.provider.clientSecret,
    ...over,
  });
  const sql = <T extends object>(text: string, bind: unknown[] = []) =>
    app.t.app.get(Sequelize).query<T>(text, { bind, type: QueryTypes.SELECT });
  const registry = () => app.t.app.get(OidcProviderRegistry);

  describe('S02 AS-56: a shop provider is believed for its subject only', () => {
    it('creates a new account without an e-mail and leaves the victim whose address it asserted untouched', async () => {
      shops.set(SHOP, settings());
      const victim = await app.t.seedUser({ email: 'victim-56@example.com' });
      const { accessToken } = await passwordLogin(
        app.t,
        'victim-56@example.com',
      );
      expect(accessToken).toBeDefined();
      await enableSecondFactor(app.t, victim.id);
      const sessionsBefore = (await authStore(app.t.app).all()).filter((i) =>
        String(i.PK).startsWith('SESSION#'),
      ).length;
      const [before] = await sql<{ passwordHash: string }>(
        `SELECT "passwordHash" FROM "User" WHERE "id" = $1`,
        [victim.id],
      );

      const flow = await startFlow(app, { provider: SHOP });
      expect(flow.res.status).toBe(200);
      const back = app.provider.approve(flow.authorizationUrl, {
        sub: 'shop-subject-1',
        email: 'victim-56@example.com',
        email_verified: true,
      });
      const res = await callback(app, back, flow.flowCookie, SHOP);

      expect(res.status).toBe(302);
      expect(res.headers.location).not.toContain('error=');
      expect(setCookies(res)['__Host-access']).toBeDefined();
      const users = await sql<{ id: string; email: string | null }>(
        `SELECT "id","email" FROM "User" ORDER BY "createdAt"`,
      );
      expect(users).toHaveLength(2);
      const created = users.find((u) => u.id !== victim.id)!;
      expect(created.email).toBeNull();
      const links = await sql<{
        userId: string;
        provider: string;
        email: string | null;
      }>(`SELECT "userId","provider","email" FROM "FederatedIdentity"`);
      expect(links).toEqual([
        {
          userId: created.id,
          provider: SHOP,
          email: 'victim-56@example.com',
        },
      ]);
      const [after] = await sql<{ passwordHash: string }>(
        `SELECT "passwordHash" FROM "User" WHERE "id" = $1`,
        [victim.id],
      );
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(
        await sql(`SELECT 1 FROM "SecondFactor" WHERE "userId" = $1`, [
          victim.id,
        ]),
      ).toHaveLength(1);
      const sessionsAfter = (await authStore(app.t.app).all()).filter((i) =>
        String(i.PK).startsWith('SESSION#'),
      ).length;
      expect(sessionsAfter).toBe(sessionsBefore + 1); // only the new account's own
    });
  });

  describe('S02 AS-57: registry lifecycle', () => {
    it('answers 404 oidc_provider_not_found for a disabled or unknown provider and for malformed ids', async () => {
      for (const provider of [
        SHOP,
        OTHER_SHOP,
        'other:1',
        'shop:',
        'x'.repeat(200),
      ]) {
        const { res } = await startFlow(app, { provider });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('oidc_provider_not_found');
      }
    });

    it('answers 503 oidc_provider_unavailable (no 500) when the resolver throws, and the callback ends in the closed error', async () => {
      shops.set(SHOP, settings());
      const flow = await startFlow(app, { provider: SHOP });
      const back = app.provider.approve(flow.authorizationUrl, { sub: 's' });
      shops.set(SHOP, 'throw');

      const started = await startFlow(app, { provider: SHOP });
      expect(started.res.status).toBe(503);
      expect(started.res.body.code).toBe('oidc_provider_unavailable');
      const res = await callback(app, back, flow.flowCookie, SHOP);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(
        '/login?error=oidc_provider_unavailable',
      );
    });

    it('invalidate drops the cached discovery: the next flow reads the provider document again', async () => {
      shops.set(SHOP, settings());
      registry().invalidate(SHOP); // earlier specs of this file left a cached document
      app.provider.reset();
      await startFlow(app, { provider: SHOP });
      await startFlow(app, { provider: SHOP });
      const path = '/.well-known/openid-configuration';
      expect(app.provider.requestsTo(path)).toHaveLength(1);

      registry().invalidate(SHOP);
      await startFlow(app, { provider: SHOP });
      expect(app.provider.requestsTo(path)).toHaveLength(2);
    });

    it('uses the settings the resolver returns now: a new client id shows in the next authorization URL', async () => {
      shops.set(SHOP, settings());
      const first = await startFlow(app, { provider: SHOP });
      shops.set(SHOP, settings({ clientId: 'rotated-client' }));
      const second = await startFlow(app, { provider: SHOP });
      const clientOf = (url: string) =>
        new URL(url).searchParams.get('client_id');
      expect(clientOf(first.authorizationUrl)).toBe(app.provider.clientId);
      expect(clientOf(second.authorizationUrl)).toBe('rotated-client');
    });

    it('refuses an empty prefix, google, an overlapping one and a duplicate at registration', () => {
      const resolver = async () => undefined;
      expect(() => registry().registerResolver('', resolver)).toThrow();
      expect(() => registry().registerResolver('google', resolver)).toThrow();
      expect(() => registry().registerResolver('goog', resolver)).toThrow();
      expect(() => registry().registerResolver('shop:', resolver)).toThrow();
      expect(() => registry().registerResolver('shop:a', resolver)).toThrow();
      expect(() => registry().registerResolver('ent:', resolver)).not.toThrow();
      expect(() => registry().registerResolver('ent:', resolver)).toThrow();
    });

    it('treats a resolver answer of the wrong shape as an unknown provider', async () => {
      for (const bad of [
        {},
        { issuer: 'not a url', clientId: 'c', clientSecret: 's' },
        { issuer: app.provider.issuer, clientId: '', clientSecret: 's' },
        { issuer: app.provider.issuer, clientId: 'c', clientSecret: 7 },
        { issuer: 'x'.repeat(5000), clientId: 'c', clientSecret: 's' },
      ]) {
        shops.set(SHOP, bad as unknown as OidcProviderSettings);
        const { res } = await startFlow(app, { provider: SHOP });
        expect(res.status).toBe(404);
      }
    });
  });
});

describe('S02 AS-58: dynamic issuers are SSRF-checked', () => {
  let app: OidcTestApp;
  const shops = new Map<string, OidcProviderSettings>();
  const resolvedTo = jest.fn(async (host: string) => {
    void host;
    return [{ address: '10.1.2.3', family: 4 as const }];
  });

  beforeAll(async () => {
    // No local-host escape hatches: the guard is the real one; only DNS is stubbed.
    app = await createOidcApp({ net: { resolver: resolvedTo } });
    standIn(
      app.t.app.get(OidcProviderRegistry),
      async (id) => shops.get(id) as OidcProviderSettings | undefined,
    );
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await flushRedis(app.t);
    app.reset();
    shops.clear();
  });

  it.each([
    ['http scheme', 'http://idp.example'],
    ['localhost', 'https://localhost'],
    ['loopback literal', 'https://127.0.0.1'],
    ['private range', 'https://10.0.0.5'],
    ['cloud metadata', 'https://169.254.169.254'],
    ['non-443 port', 'https://idp.example:8443'],
    [
      'hostname that resolves to a private address (DNS rebinding)',
      'https://rebind.example',
    ],
  ])(
    'answers 404 and makes no outbound request for %s',
    async (_name, issuer) => {
      shops.set(SHOP, { issuer, clientId: 'c', clientSecret: 's' });
      const httpsSpy = jest.spyOn(https, 'request');
      const httpSpy = jest.spyOn(http, 'request');
      try {
        const { res } = await startFlow(app, { provider: SHOP });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe('oidc_provider_not_found');
        // The test's own request to the API goes through `http`; anything else would be the app calling out.
        const outbound = [...httpsSpy.mock.calls, ...httpSpy.mock.calls].filter(
          ([target]) =>
            !String((target as { path?: string }).path ?? '').startsWith(
              '/api/',
            ),
        );
        expect(outbound).toEqual([]);
        expect(JSON.stringify(res.body)).not.toContain('10.1.2.3');
      } finally {
        httpsSpy.mockRestore();
        httpSpy.mockRestore();
      }
    },
  );
});
