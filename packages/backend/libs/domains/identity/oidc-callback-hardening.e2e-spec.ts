import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { authStore } from './testing/auth-app';
import { flushRedis } from './testing/mfa-fixtures';
import {
  FRONT,
  OidcTestApp,
  callback,
  createOidcApp,
  setCookies,
  sha256Hex,
  signIn,
  startFlow,
} from './testing/oidc-fixtures';

const CLAIMS = { sub: 'g-1', email: 'hard@example.com', email_verified: true };

describe('Forged, replayed and interrupted OIDC callbacks', () => {
  let app: OidcTestApp;

  beforeAll(async () => {
    // A short provider deadline keeps the hung-endpoint cases fast; the production default is 3 s.
    app = await createOidcApp({ timeoutMs: 400 });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await app.t.reset();
    await flushRedis(app.t);
    app.reset();
  });

  const count = async (table: string) =>
    Number(
      (
        await app.t.app
          .get(Sequelize)
          .query<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`, {
            type: QueryTypes.SELECT,
          })
      )[0].n,
    );
  const sessions = async () =>
    (await authStore(app.t.app).all()).filter((i) =>
      String(i.PK).startsWith('SESSION#'),
    ).length;
  const nothingCreated = async () => {
    expect(await count('User')).toBe(0);
    expect(await count('FederatedIdentity')).toBe(0);
    expect(await sessions()).toBe(0);
  };
  const flowKeys = () => app.t.app.get(RedisService).client.keys('oidc:flow:*');
  const loginCount = (result: string) =>
    MetricsRegistry.value('auth_oidc_login_total', {
      provider: 'google',
      result,
    }) ?? 0;
  const timeouts = () =>
    MetricsRegistry.value('auth_oidc_provider_timeout_total') ?? 0;
  const errorOf = (res: { headers: Record<string, string> }) =>
    new URL(res.headers.location).searchParams.get('error');

  describe('S02 AS-37: state, cookie and provider binding', () => {
    /** A started and approved flow, returned as the pieces a forger could vary. */
    async function approved() {
      const flow = await startFlow(app);
      const back = new URL(app.provider.approve(flow.authorizationUrl, CLAIMS));
      return { ...flow, back };
    }

    it('refuses a callback without a state', async () => {
      const res = await app.t
        .http()
        .get('/api/auth/oidc/google/callback?code=abc')
        .expect(302);
      expect(res.headers.location).toBe(
        `${FRONT}/login?error=oidc_state_invalid`,
      );
      await nothingCreated();
      expect(app.provider.requestsTo('/token')).toHaveLength(0);
    });

    it('refuses an unknown state', async () => {
      const f = await approved();
      f.back.searchParams.set('state', 'unknown-state-value');
      const res = await callback(app, f.back.toString(), f.flowCookie);
      expect(errorOf(res)).toBe('oidc_state_invalid');
      await nothingCreated();
      expect(app.provider.requestsTo('/token')).toHaveLength(0);
    });

    it('refuses a state older than ten minutes', async () => {
      const f = await approved();
      const key = `oidc:flow:${sha256Hex(f.back.searchParams.get('state')!)}`;
      const redis = app.t.app.get(RedisService).client;
      await redis.pexpire(key, 1);
      await new Promise((r) => setTimeout(r, 20));
      const res = await callback(app, f.back.toString(), f.flowCookie);
      expect(errorOf(res)).toBe('oidc_state_invalid');
      await nothingCreated();
    });

    it('refuses the replay of a callback that already completed', async () => {
      const f = await approved();
      const first = await callback(app, f.back.toString(), f.flowCookie);
      expect(first.headers.location).toBe(`${FRONT}/`);
      const sessionsBefore = await sessions();

      const replay = await callback(app, f.back.toString(), f.flowCookie);

      expect(errorOf(replay)).toBe('oidc_state_invalid');
      expect(await sessions()).toBe(sessionsBefore);
      expect(app.provider.requestsTo('/token')).toHaveLength(1);
    });

    it.each([
      [
        "no flow cookie (the attacker's link opened in another browser)",
        undefined,
      ],
      ['another cookie value', 'a-different-browsers-cookie-value'],
    ])(
      'refuses a valid state with %s, and spends the flow',
      async (_n, cookie) => {
        const f = await approved();
        const res = await callback(app, f.back.toString(), cookie);
        expect(errorOf(res)).toBe('oidc_state_invalid');
        await nothingCreated();
        expect(app.provider.requestsTo('/token')).toHaveLength(0);
        expect(await flowKeys()).toEqual([]);
        // the real browser cannot use it any more either
        const late = await callback(app, f.back.toString(), f.flowCookie);
        expect(errorOf(late)).toBe('oidc_state_invalid');
      },
    );

    it('refuses a valid state under another provider name, and spends the flow', async () => {
      const f = await approved();
      const res = await callback(
        app,
        f.back.toString(),
        f.flowCookie,
        'facebook',
      );
      expect(errorOf(res)).toBe('oidc_state_invalid');
      await nothingCreated();
      expect(app.provider.requestsTo('/token')).toHaveLength(0);
      expect(await flowKeys()).toEqual([]);
    });

    it('answers the 31st callback from one address within a minute with 429 and consumes no flow', async () => {
      const f = await approved(); // one request of the budget (start shares the policy)
      for (let i = 0; i < 29; i++)
        await app.t
          .http()
          .get('/api/auth/oidc/google/callback?state=x')
          .expect(302);

      const res = await callback(app, f.back.toString(), f.flowCookie).expect(
        429,
      );

      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(await flowKeys()).toHaveLength(1);
      expect(app.provider.requestsTo('/token')).toHaveLength(0);
    });
  });

  it('S02 AS-38: two parallel callbacks with one state yield one session and one token request', async () => {
    const flow = await startFlow(app);
    const back = app.provider.approve(flow.authorizationUrl, CLAIMS);

    const results = await Promise.all([
      callback(app, back, flow.flowCookie),
      callback(app, back, flow.flowCookie),
    ]);

    expect(results.map(errorOf).sort()).toEqual([null, 'oidc_state_invalid']);
    expect(await sessions()).toBe(1);
    expect(await count('User')).toBe(1);
    expect(app.provider.requestsTo('/token')).toHaveLength(1);
  });

  describe('S02 AS-39: provider errors and missing codes', () => {
    it.each(['access_denied', 'server_error', 'login_required'])(
      'maps error=%s to oidc_denied without echoing provider text',
      async (error) => {
        const flow = await startFlow(app);
        const back = app.provider.approve(flow.authorizationUrl, CLAIMS, {
          error,
        });

        const res = await callback(app, back, flow.flowCookie);

        expect(res.headers.location).toBe(`${FRONT}/login?error=oidc_denied`);
        expect(JSON.stringify(res.headers)).not.toContain(
          'secret provider text',
        );
        expect(await flowKeys()).toEqual([]);
        await nothingCreated();
        expect(app.provider.requestsTo('/token')).toHaveLength(0);
      },
    );

    it('maps a missing code and a repeated code to oidc_exchange_failed', async () => {
      for (const mutate of [
        (u: URL) => u.searchParams.delete('code'),
        (u: URL) => u.searchParams.append('code', 'second'),
      ]) {
        const flow = await startFlow(app);
        const back = new URL(
          app.provider.approve(flow.authorizationUrl, CLAIMS),
        );
        mutate(back);
        const res = await callback(app, back.toString(), flow.flowCookie);
        expect(errorOf(res)).toBe('oidc_exchange_failed');
      }
      await nothingCreated();
      expect(app.provider.requestsTo('/token')).toHaveLength(0);
    });
  });

  describe('S02 AS-40: token endpoint failures', () => {
    it.each([
      'status-400',
      'status-401',
      'status-500',
      'not-json',
      'no-id-token',
      'oversize',
    ] as const)('maps %s to oidc_exchange_failed', async (fault) => {
      app.provider.faults.token = fault;

      const { res } = await signIn(app, CLAIMS);

      expect(res.headers.location).toBe(
        `${FRONT}/login?error=oidc_exchange_failed`,
      );
      expect(Object.keys(setCookies(res))).toEqual(['__Host-oidc-flow']);
      await nothingCreated();
      expect(await flowKeys()).toEqual([]);
    });
  });

  describe('S02 AS-41: a provider that does not answer', () => {
    it('ends the callback in oidc_provider_unavailable after exactly one token request, and counts it', async () => {
      app.provider.faults.token = 'hang';
      const before = {
        login: loginCount('provider_unavailable'),
        t: timeouts(),
      };
      const started = Date.now();

      const { res } = await signIn(app, CLAIMS);

      expect(Date.now() - started).toBeLessThan(10_000);
      expect(res.headers.location).toBe(
        `${FRONT}/login?error=oidc_provider_unavailable`,
      );
      expect(app.provider.requestsTo('/token')).toHaveLength(1);
      await nothingCreated();
      expect(await flowKeys()).toEqual([]);
      expect(loginCount('provider_unavailable')).toBe(before.login + 1);
      expect(timeouts()).toBe(before.t + 1);
    });

    it.each([
      ['discovery', () => (app.provider.faults.discovery = 'hang')],
      ['key set', () => (app.provider.faults.jwks = 'hang')],
    ])('behaves the same for a hung %s request', async (_n, hang) => {
      const flow = await startFlow(app);
      const back = app.provider.approve(flow.authorizationUrl, CLAIMS);
      // drop what start learned so the callback has to ask the provider again
      app.forgetDiscovery();
      hang();

      const res = await callback(app, back, flow.flowCookie);

      expect(errorOf(res)).toBe('oidc_provider_unavailable');
      await nothingCreated();
    });
  });

  describe('S02 AS-42: discovery integrity and caching', () => {
    it.each(['issuer-mismatch', 'http-endpoint', 'oversize'] as const)(
      'refuses a discovery document with %s: start answers 503 and stores no flow',
      async (fault) => {
        app.provider.faults.discovery = fault;
        const { res } = await startFlow(app);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('oidc_provider_unavailable');
        expect(await flowKeys()).toEqual([]);
      },
    );

    it('asks for the discovery document once for many starts within an hour, and again after it', async () => {
      for (let i = 0; i < 25; i++)
        expect((await startFlow(app)).res.status).toBe(200);
      expect(
        app.provider.requestsTo('/.well-known/openid-configuration'),
      ).toHaveLength(1);

      app.t.clock.advance(3_600_000 + 1000);
      expect((await startFlow(app)).res.status).toBe(200);
      expect(
        app.provider.requestsTo('/.well-known/openid-configuration'),
      ).toHaveLength(2);
    });

    it('reloads the key set at most once per 30 seconds for an unknown key', async () => {
      app.provider.faults.idToken = { unknownKid: true };
      await signIn(app, CLAIMS);
      await signIn(app, CLAIMS);
      expect(app.provider.requestsTo('/jwks')).toHaveLength(1);

      app.t.clock.advance(31_000);
      await signIn(app, CLAIMS);
      expect(app.provider.requestsTo('/jwks')).toHaveLength(2);
    });
  });
});
