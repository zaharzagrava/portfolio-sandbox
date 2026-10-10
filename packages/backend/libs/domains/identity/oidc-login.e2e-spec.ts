import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  oidcProviderSchema,
  oidcStartSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { authStore, decodeJwt } from './testing/auth-app';
import { flushRedis } from './testing/mfa-fixtures';
import {
  FRONT,
  CALLBACK_URL,
  OidcTestApp,
  callback,
  cookieValue,
  createOidcApp,
  setCookies,
  sha256Hex,
  signIn,
  startFlow,
} from './testing/oidc-fixtures';

describe('Sign in with Google', () => {
  let app: OidcTestApp;

  beforeAll(async () => {
    app = await createOidcApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await app.t.reset();
    await flushRedis(app.t);
    app.reset();
  });

  const sql = <T extends object>(text: string, bind: unknown[] = []) =>
    app.t.app.get(Sequelize).query<T>(text, { bind, type: QueryTypes.SELECT });
  const flowKeys = () => app.t.app.get(RedisService).client.keys('oidc:flow:*');
  const users = () =>
    sql<{
      id: string;
      email: string | null;
      passwordHash: string | null;
      role: string;
    }>(`SELECT "id","email","passwordHash","role" FROM "User"`);
  const links = () =>
    sql<{
      userId: string;
      provider: string;
      subject: string;
      email: string | null;
    }>(`SELECT * FROM "FederatedIdentity"`);
  const sessions = async () =>
    (await authStore(app.t.app).all()).filter((i) =>
      String(i.PK).startsWith('SESSION#'),
    );

  describe('S02 AS-28: the provider list', () => {
    it('lists Google when it is configured', async () => {
      const res = await app.t
        .http()
        .get('/api/auth/oidc/providers')
        .expect(200);
      expect(oidcProviderSchema.array().parse(res.body)).toEqual([
        { id: 'google', displayName: 'Google' },
      ]);
    });

    it('is empty when Google is not configured', async () => {
      const config = app.t.app.get(ApiConfigService, { strict: false });
      const real = config.get.bind(config);
      const spy = jest
        .spyOn(config, 'get')
        .mockImplementation(((key: string) =>
          key.startsWith('google_oidc_client')
            ? undefined
            : real(key as never)) as never);
      try {
        const res = await app.t
          .http()
          .get('/api/auth/oidc/providers')
          .expect(200);
        expect(res.body).toEqual([]);
        const start = await startFlow(app);
        expect(start.res.status).toBe(404);
        expect(problemDetailsSchema.parse(start.res.body).code).toBe(
          'oidc_provider_not_found',
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('S02 AS-29: start returns the authorization URL with PKCE, state and nonce, binds the browser with a cookie and stores only digests', async () => {
    const { res, authorizationUrl, flowCookie } = await startFlow(app, {
      returnTo: '/account',
    });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { authorizationUrl: url } = oidcStartSchema.parse(res.body);
    const p = new URL(url);
    expect(`${p.origin}${p.pathname}`).toBe(`${app.provider.issuer}/authorize`);
    const q = Object.fromEntries(p.searchParams.entries());
    expect(q).toMatchObject({
      response_type: 'code',
      client_id: app.provider.clientId,
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      redirect_uri: CALLBACK_URL,
    });
    expect(q.state.length).toBeGreaterThanOrEqual(43);
    expect(q.nonce.length).toBeGreaterThanOrEqual(43);
    expect(q.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizationUrl).not.toContain(app.provider.clientSecret);
    expect(authorizationUrl).not.toContain('code_verifier');

    const cookie = setCookies(res)['__Host-oidc-flow'];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).not.toContain('Domain=');

    const key = `oidc:flow:${sha256Hex(q.state)}`;
    const redis = app.t.app.get(RedisService).client;
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
    const stored = JSON.parse((await redis.get(key))!);
    expect(stored).toMatchObject({
      provider: 'google',
      purpose: 'login',
      returnPath: '/account',
      cookieDigest: sha256Hex(flowCookie!),
    });
    expect(JSON.stringify(stored)).not.toContain(flowCookie!);
    expect(await flowKeys()).toEqual([key]);
  });

  describe('S02 AS-30: start rejections', () => {
    it.each([
      'facebook',
      'GOOGLE',
      'google%20',
      'shop:not-a-uuid',
      '..%2Fx',
      'a'.repeat(200),
    ])(
      'answers an identical 404 for the provider %s and stores no flow',
      async (name) => {
        const res = await app.t
          .http()
          .post(`/api/auth/oidc/${name}/start`)
          .send({});
        expect(res.status).toBe(404);
        expect(problemDetailsSchema.parse(res.body).code).toBe(
          'oidc_provider_not_found',
        );
        expect(await flowKeys()).toEqual([]);
        const { instance: _i, requestId: _r, ...rest } = res.body;
        expect(rest).toEqual({
          type: expect.any(String),
          title: 'Not Found',
          status: 404,
          detail: 'No such sign-in provider.',
          code: 'oidc_provider_not_found',
        });
      },
    );

    it('refuses a foreign origin with 403', async () => {
      const { res } = await startFlow(app, {
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'origin_not_allowed',
      );
      expect(await flowKeys()).toEqual([]);
    });

    it('refuses a form body with 415', async () => {
      const res = await app.t
        .http()
        .post('/api/auth/oidc/google/start')
        .type('form')
        .send('returnTo=/x');
      expect(res.status).toBe(415);
      expect(await flowKeys()).toEqual([]);
    });

    it.each([
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'account',
      '',
    ])(
      'refuses the return path %j with 400 naming returnTo and stores no flow',
      async (returnTo) => {
        const { res } = await startFlow(app, { returnTo });
        expect(res.status).toBe(400);
        expect(problemDetailsSchema.parse(res.body).code).toBe(
          'validation_failed',
        );
        expect(JSON.stringify(res.body)).toContain('returnTo');
        expect(await flowKeys()).toEqual([]);
      },
    );

    it('answers the 31st start from one address within a minute with 429 and Retry-After', async () => {
      for (let i = 0; i < 30; i++)
        expect((await startFlow(app)).res.status).toBe(200);
      const { res } = await startFlow(app);
      expect(res.status).toBe(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('answers 503 oidc_provider_unavailable when the provider cannot be discovered, and stores no flow', async () => {
      app.provider.faults.discovery = 'status-500';
      const { res } = await startFlow(app);
      expect(res.status).toBe(503);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'oidc_provider_unavailable',
      );
      expect(await flowKeys()).toEqual([]);
    });
  });

  it('S02 AS-31: a first sign-in creates the account, the link, the cookie session and the events, and keeps no provider token', async () => {
    const { res, flowCookie } = await signIn(
      app,
      { sub: 'g-123', email: 'New@Example.com', email_verified: true },
      { returnTo: '/account' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONT}/account`);
    const cookies = setCookies(res);
    for (const name of ['__Host-access', '__Host-refresh', '__Host-csrf'])
      expect(cookies[name]).toBeDefined();
    expect(cookies['__Host-access']).toContain('HttpOnly');
    expect(cookies['__Host-csrf']).not.toContain('HttpOnly');
    expect(cookies['__Host-oidc-flow']).toMatch(/Expires=Thu, 01 Jan 1970/);

    const [user] = await users();
    expect(await users()).toHaveLength(1);
    expect(user).toMatchObject({
      email: 'new@example.com',
      role: 'USER',
      passwordHash: null,
    });
    expect(await links()).toEqual([
      expect.objectContaining({
        userId: user.id,
        provider: 'google',
        subject: 'g-123',
        email: 'new@example.com',
      }),
    ]);

    const claims = decodeJwt(cookieValue(cookies['__Host-access'])).claims;
    expect(claims).toMatchObject({ sub: user.id, amr: ['fed'] });
    expect(await sessions()).toHaveLength(1);

    const events = (await outboxRowsFor(app.t.app, user.id)).map(
      (e) => e.payload,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'identity.user_registered',
          version: 1,
        }),
        expect.objectContaining({
          type: 'identity.federated_identity_linked',
          version: 1,
          payload: {
            userId: user.id,
            provider: 'google',
            linkMethod: 'login',
            passwordInvalidated: false,
            mfaReset: false,
          },
        }),
      ]),
    );

    // The provider saw PKCE (it verifies the verifier itself) and exactly one code exchange.
    const exchanges = app.provider.requestsTo('/token');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].params.code_verifier).toEqual(expect.any(String));
    // No provider token anywhere we keep state.
    const tokenSeen = (text: string) => /\bat-[A-Za-z0-9_-]{16}/.test(text);
    expect(tokenSeen(JSON.stringify(await authStore(app.t.app).all()))).toBe(
      false,
    );
    expect(tokenSeen(JSON.stringify(await links()))).toBe(false);
    expect(tokenSeen(JSON.stringify(await users()))).toBe(false);
    const redis = app.t.app.get(RedisService).client;
    for (const key of await redis.keys('*'))
      if ((await redis.type(key)) === 'string')
        expect(tokenSeen((await redis.get(key)) ?? '')).toBe(false);
    expect(flowCookie).toBeDefined();
  });

  it('S02 AS-32: a returning user is signed in to the same account whatever e-mail the provider reports now', async () => {
    await signIn(app, {
      sub: 'g-123',
      email: 'first@example.com',
      email_verified: true,
    });
    const [user] = await users();

    const { res } = await signIn(app, {
      sub: 'g-123',
      email: 'changed@example.com',
      email_verified: true,
    });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONT}/`);
    expect(await users()).toHaveLength(1);
    expect((await users())[0]).toMatchObject({
      id: user.id,
      email: 'first@example.com',
    });
    expect(await links()).toHaveLength(1);
    expect(await sessions()).toHaveLength(2);
    const types = (await outboxRowsFor(app.t.app, user.id)).map(
      (e) => e.payload.type,
    );
    expect(types.filter((t) => t === 'identity.user_registered')).toHaveLength(
      1,
    );
    expect(
      types.filter((t) => t === 'identity.federated_identity_linked'),
    ).toHaveLength(1);
  });

  describe('S02 AS-33: callback responses', () => {
    it('are non-cacheable redirects to the front end only, whatever the query says', async () => {
      const flow = await startFlow(app, { returnTo: '/account' });
      const back = new URL(
        app.provider.approve(flow.authorizationUrl, {
          sub: 'g-1',
          email: 'a@example.com',
          email_verified: true,
        }),
      );
      back.searchParams.set('returnTo', '//evil.example');
      back.searchParams.set('redirect', 'https://evil.example');
      back.searchParams.set('next', 'https://evil.example');
      back.searchParams.set('url', 'https://evil.example');

      const res = await callback(app, back.toString(), flow.flowCookie);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${FRONT}/account`);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      for (const secret of ['code=', 'state=', 'a@example.com'])
        expect(res.headers.location).not.toContain(secret);
    });

    it('are the same for a failure', async () => {
      const res = await app.t
        .http()
        .get('/api/auth/oidc/google/callback?state=nope&code=x')
        .expect(302);
      expect(res.headers.location).toBe(
        `${FRONT}/login?error=oidc_state_invalid`,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });
  });

  describe('S02 AS-35: ID-token attacks end in oidc_token_invalid', () => {
    const attacks: Array<
      [string, NonNullable<typeof app.provider.faults.idToken>]
    > = [
      ['a wrong nonce', { nonce: 'not-the-nonce' }],
      ['a missing nonce', { nonce: null }],
      ['a wrong audience', { aud: 'someone-else' }],
      ['a different issuer', { iss: 'https://elsewhere.example' }],
      [
        'several audiences with a foreign azp',
        { aud: ['fake-client-id', 'x'], azp: 'x' },
      ],
      ['an expiry 6 s in the past', { exp: -6 }],
      ['a signature by a key outside the key set', { unknownKid: true }],
      ['alg none', { alg: 'none' }],
      ['alg HS256 signed with the client secret', { alg: 'HS256' }],
      ['no expiry', { exp: null }],
      ['an oversized token', { oversize: true }],
    ];

    it.each(attacks)('with %s', async (_name, fault) => {
      app.provider.faults.idToken = fault;

      const { res } = await signIn(app, {
        sub: 'g-9',
        email: 'x@example.com',
        email_verified: true,
      });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        `${FRONT}/login?error=oidc_token_invalid`,
      );
      expect(Object.keys(setCookies(res))).toEqual(['__Host-oidc-flow']);
      expect(await users()).toHaveLength(0);
      expect(await links()).toHaveLength(0);
      expect(await sessions()).toHaveLength(0);
    });

    it('with no subject', async () => {
      const { res } = await signIn(app, {
        sub: undefined as unknown as string,
        email: 'x@example.com',
        email_verified: true,
      });
      expect(res.headers.location).toBe(
        `${FRONT}/login?error=oidc_token_invalid`,
      );
      expect(await users()).toHaveLength(0);
    });

    it('accepts an expiry 3 s in the past (inside the 5 s tolerance)', async () => {
      app.provider.faults.idToken = { exp: -3 };
      const { res } = await signIn(app, {
        sub: 'g-3',
        email: 'y@example.com',
        email_verified: true,
      });
      expect(res.headers.location).toBe(`${FRONT}/`);
      expect(await users()).toHaveLength(1);
    });
  });

  it('S02 AS-36: a claim set without a verified e-mail is refused with email_not_verified and nothing is stored', async () => {
    const { res } = await signIn(app, {
      sub: 'g-7',
      email: 'unverified@example.com',
      email_verified: 'true',
    });

    expect(res.headers.location).toBe(
      `${FRONT}/login?error=email_not_verified`,
    );
    expect(await users()).toHaveLength(0);
    expect(await links()).toHaveLength(0);
  });
});
