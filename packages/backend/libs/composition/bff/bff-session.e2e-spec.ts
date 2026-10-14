import { createHash } from 'node:crypto';
import {
  BFF_COOKIES,
  mfaRequiredResponseSchema,
  problemDetailsSchema,
  sessionResponseSchema,
} from '@marketplace-sandbox/contracts';
import {
  ALLOWED_ORIGIN,
  BffTestApp,
  bffKeys,
  createBffApp,
  resetBffRedis,
} from './testing/app-factory';
import { identitySessionFixture } from './testing/fixtures';
import { cookiesOf, seedProduct, signIn } from './testing/helpers';
import { StubUpstream, TripwireServer } from './testing/stub-upstream';
import { BreakerRegistry } from './upstream/breaker-registry';
import { SessionStore } from './session/session-store';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const sessionKeyOf = (cookie: string) => `bff:sess:${sha256(cookie)}`;

describe('BFF session handling', () => {
  let stub: StubUpstream;
  let tripwire: TripwireServer;
  let ctx: BffTestApp;
  let second: BffTestApp;

  beforeAll(async () => {
    stub = await StubUpstream.start();
    tripwire = await TripwireServer.start();
    ctx = await createBffApp({ upstreamUrl: stub.url });
    second = await createBffApp({ upstreamUrl: stub.url, clock: ctx.clock });
  });
  afterAll(async () => {
    await second.close();
    await ctx.close();
    await stub.close();
    await tripwire.close();
  });
  beforeEach(async () => {
    stub.reset();
    tripwire.requests.length = 0;
    ctx.clock.set(T0);
    for (const a of [ctx, second]) a.app.get(BreakerRegistry).reset();
    await resetBffRedis(ctx.redis);
    jest.restoreAllMocks();
  });

  const parseProblem = (body: unknown) => problemDetailsSchema.parse(body);
  const login = (
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    app = ctx,
  ) =>
    app
      .http()
      .post('/api/bff/session')
      .set({ Origin: ALLOWED_ORIGIN, ...headers })
      .send({
        email: 'shopper@example.com',
        password: 'correct horse',
        ...over,
      });
  const setCookieLines = (res: {
    headers: Record<string, unknown>;
  }): string[] => {
    const raw = res.headers['set-cookie'];
    return Array.isArray(raw) ? (raw as string[]) : raw ? [String(raw)] : [];
  };
  const lineOf = (lines: string[], name: string) =>
    lines.find((l) => l.startsWith(`${name}=`));
  const page = (id: string, cookie?: string, app = ctx) => {
    const r = app.http().get(`/api/bff/product-page/${id}`);
    return cookie ? r.set('Cookie', cookie) : r;
  };
  const rawRecord = async (cookie: string) =>
    ctx.redis.client.get(sessionKeyOf(cookie));

  describe('login (US4)', () => {
    it('S48 AS-43: login sets the two cookies, returns the user and no token, and stores one encrypted record keyed by the hash', async () => {
      const body = identitySessionFixture({
        accessToken: 'ACCESS-SECRET-1',
        refreshToken: 'REFRESH-SECRET-1',
      });
      stub.respondInOrder('login', [{ body }]);
      const res = await login().expect(200);
      const session = sessionResponseSchema.parse(res.body);
      expect(session.user).toEqual(body.user);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(stub.callsTo('login')).toHaveLength(1);
      expect(stub.callsTo('login')[0].body).toEqual({
        email: 'shopper@example.com',
        password: 'correct horse',
      });

      const lines = setCookieLines(res);
      const sessionLine = lineOf(lines, BFF_COOKIES.session)!;
      const csrfLine = lineOf(lines, BFF_COOKIES.csrf)!;
      expect(sessionLine).toMatch(/; Path=\/(;|$)/);
      expect(sessionLine).toContain('HttpOnly');
      expect(sessionLine).toContain('Secure');
      expect(sessionLine).toContain('SameSite=Lax');
      expect(sessionLine).not.toMatch(/Domain=/i);
      expect(csrfLine).toContain('Secure');
      expect(csrfLine).toContain('SameSite=Lax');
      expect(csrfLine).not.toContain('HttpOnly');
      expect(csrfLine).not.toMatch(/Domain=/i);
      expect(lines).toHaveLength(2);

      const everything = JSON.stringify([res.body, res.headers]);
      for (const secret of ['ACCESS-SECRET-1', 'REFRESH-SECRET-1'])
        expect(everything).not.toContain(secret);

      const cookie = cookiesOf(res)[BFF_COOKIES.session];
      expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 random bits, base64url
      const keys = await bffKeys(ctx.redis, 'bff:*');
      expect(keys).toEqual([sessionKeyOf(cookie)]);
      const stored = (await rawRecord(cookie))!;
      for (const secret of [
        'ACCESS-SECRET-1',
        'REFRESH-SECRET-1',
        body.user.id,
        'shopper@example.com',
      ])
        expect(stored).not.toContain(secret);
      const decoded = stored
        .split('.')
        .map((p) => Buffer.from(p, 'base64url').toString('latin1'))
        .join('|');
      expect(decoded).not.toContain('ACCESS-SECRET-1');
      const ttl = await ctx.redis.client.pttl(sessionKeyOf(cookie));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(DAY + 5_000); // the idle deadline comes first
    });

    it('S48 AS-44: a login from a disallowed origin (or cross-site without Origin) is 403 with no cookie, no session and no identity call', async () => {
      const bad = await login({}, { Origin: 'https://evil.example' }).expect(
        403,
      );
      expect(parseProblem(bad.body).code).toBe('origin_not_allowed');
      expect(setCookieLines(bad)).toHaveLength(0);
      const cross = await ctx
        .http()
        .post('/api/bff/session')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ email: 'a@b.co', password: 'x' })
        .expect(403);
      expect(parseProblem(cross.body).code).toBe('origin_not_allowed');
      expect(stub.callsTo('login')).toHaveLength(0);
      expect(await bffKeys(ctx.redis, 'bff:sess:*')).toHaveLength(0);
      // no Origin at all and no Sec-Fetch-Site is a non-browser client: allowed
      stub.respondInOrder('login', [{ body: identitySessionFixture() }]);
      await ctx
        .http()
        .post('/api/bff/session')
        .send({ email: 'a@b.co', password: 'x' })
        .expect(200);
    });

    it('S48 AS-45: identity answers are relayed in meaning; no cookie and no session on failure', async () => {
      stub.respondInOrder('login', [
        {
          status: 401,
          body: {
            code: 'invalid_credentials',
            detail: 'no such user bob@example.com',
          },
        },
        {
          status: 401,
          body: {
            code: 'invalid_credentials',
            detail: 'wrong password for alice@example.com',
          },
        },
        {
          status: 429,
          body: { code: 'rate_limited' },
          headers: { 'retry-after': '7' },
        },
        {
          status: 503,
          body: { code: 'overloaded' },
          headers: { 'retry-after': '3' },
        },
      ]);
      const unknown = await login({ email: 'bob@example.com' }).expect(401);
      const wrong = await login({ email: 'alice@example.com' }).expect(401);
      const strip = (b: Record<string, unknown>) => ({
        ...b,
        requestId: undefined,
        instance: undefined,
      });
      expect(strip(unknown.body)).toEqual(strip(wrong.body));
      expect(parseProblem(unknown.body).code).toBe('invalid_credentials');
      expect(JSON.stringify(unknown.body)).not.toMatch(/bob|alice/);
      const limited = await login().expect(429);
      expect(parseProblem(limited.body).code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBe('7');
      const busy = await login().expect(503);
      expect(busy.headers['retry-after']).toBeDefined();
      for (const r of [unknown, wrong, limited, busy])
        expect(setCookieLines(r)).toHaveLength(0);
      expect(await bffKeys(ctx.redis, 'bff:sess:*')).toHaveLength(0);
    });

    it('S48 AS-45: invalid input is rejected before any identity call', async () => {
      const calls = () => stub.callsTo('login').length;
      const code = async (r: Promise<{ body: unknown }>) =>
        parseProblem((await r).body).code;
      expect(await code(login({ email: undefined }).expect(400))).toBe(
        'validation_failed',
      );
      expect(await code(login({ password: undefined }).expect(400))).toBe(
        'validation_failed',
      );
      expect(await code(login({ extra: 1 }).expect(400))).toBe(
        'validation_failed',
      );
      expect(await code(login({ email: 'not-an-email' }).expect(400))).toBe(
        'validation_failed',
      );
      expect(
        await code(login({ password: 'x'.repeat(20_000) }).expect(413)),
      ).toBe('payload_too_large');
      const media = await ctx
        .http()
        .post('/api/bff/session')
        .set({ Origin: ALLOWED_ORIGIN, 'Content-Type': 'text/plain' })
        .send('email=a');
      expect(media.status).toBe(415);
      expect(parseProblem(media.body).code).toBe('unsupported_media_type');
      expect(calls()).toBe(0);
    });

    it('S48 AS-45: the twenty-first login from one address in a minute is 429 with the structured rate-limit headers', async () => {
      stub.respond('login', {
        status: 401,
        body: { code: 'invalid_credentials' },
      });
      for (let i = 0; i < 20; i++) await login().expect(401);
      const denied = await login().expect(429);
      expect(parseProblem(denied.body).code).toBe('rate_limited');
      expect(denied.headers['ratelimit-policy']).toContain(
        'bff.session.login.ip',
      );
      expect(denied.headers['retry-after']).toBeDefined();
      expect(stub.callsTo('login')).toHaveLength(20);
    });

    it('S48 AS-46: identity calls carry the real client address; a client-supplied header from an untrusted peer is ignored', async () => {
      stub.respondInOrder('login', [
        { body: identitySessionFixture() },
        { body: identitySessionFixture() },
      ]);
      await login({}, { 'X-Forwarded-For': '198.51.100.99' }).expect(200);
      expect(
        String(stub.callsTo('login')[0].headers['x-forwarded-for']),
      ).toMatch(/^(::ffff:)?127\.0\.0\.1$/);

      const behindProxy = await createBffApp({
        upstreamUrl: stub.url,
        env: { TRUSTED_PROXIES: '127.0.0.1,::1,::ffff:127.0.0.1' },
      });
      try {
        await login(
          {},
          { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' },
          behindProxy,
        ).expect(200);
        // the first untrusted hop walking from the right: the real shopper
        expect(
          String(stub.callsTo('login')[1].headers['x-forwarded-for']),
        ).toBe('10.0.0.1');
      } finally {
        await behindProxy.close();
      }
    });

    it('S48 AS-47: logging in again issues a new session, deletes the old one at once and revokes the old identity session best effort', async () => {
      const first = await signIn(ctx, stub, {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
      });
      stub.respondInOrder('login', [
        { body: identitySessionFixture({ accessToken: 'new-access' }) },
      ]);
      stub.respond('logout', { status: 503, body: {} }); // revocation fails: login must not
      const res = await login({}, { Cookie: first.cookie }).expect(200);
      const next = cookiesOf(res)[BFF_COOKIES.session];
      expect(next).not.toBe(first.sessionCookie);
      expect(await rawRecord(first.sessionCookie)).toBeNull();
      expect(await rawRecord(next)).not.toBeNull();
      expect(stub.callsTo('logout')).toHaveLength(1);
      expect(stub.callsTo('logout')[0].headers.authorization).toBe(
        'Bearer old-access',
      );
      await ctx
        .http()
        .get('/api/bff/session')
        .set('Cookie', first.cookie)
        .expect(401);
      // a client-chosen session id is never adopted
      const forged = 'A'.repeat(43);
      stub.respondInOrder('login', [{ body: identitySessionFixture() }]);
      const fresh = await login(
        {},
        { Cookie: `${BFF_COOKIES.session}=${forged}` },
      ).expect(200);
      expect(cookiesOf(fresh)[BFF_COOKIES.session]).not.toBe(forged);
    });
  });

  describe('second factor (US4)', () => {
    const challenge = { mfaRequired: true, mfaToken: 'MFA-CHALLENGE-SECRET' };
    const mfa = (
      code: string,
      headers: Record<string, string> = {},
      app = ctx,
    ) =>
      app
        .http()
        .post('/api/bff/session/mfa')
        .set({ Origin: ALLOWED_ORIGIN, ...headers })
        .send({ code });
    const startChallenge = async () => {
      stub.respondInOrder('login', [{ body: challenge }]);
      const res = await login().expect(200);
      return { res, mfaCookie: cookiesOf(res)[BFF_COOKIES.mfa] };
    };

    it('S48 AS-48: a second factor answers mfaRequired, sets only the pending cookie and never exposes the challenge', async () => {
      const { res, mfaCookie } = await startChallenge();
      expect(mfaRequiredResponseSchema.parse(res.body)).toEqual({
        mfaRequired: true,
      });
      const lines = setCookieLines(res);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${BFF_COOKIES.mfa}=`);
      expect(lines[0]).toContain('HttpOnly');
      expect(lines[0]).toContain('Secure');
      expect(lines[0]).toContain('SameSite=Lax');
      expect(lines[0]).toMatch(/; Path=\/(;|$)/); // a __Host- cookie needs Path=/
      expect(lines[0]).toContain('Max-Age=300');
      expect(JSON.stringify([res.body, res.headers])).not.toContain(
        'MFA-CHALLENGE-SECRET',
      );
      const keys = await bffKeys(ctx.redis, 'bff:*');
      expect(keys).toEqual([`bff:mfa:${sha256(mfaCookie)}`]);
      expect(await ctx.redis.client.get(keys[0])).not.toContain(
        'MFA-CHALLENGE-SECRET',
      );
      expect(await ctx.redis.client.pttl(keys[0])).toBeLessThanOrEqual(300_000);

      const body = identitySessionFixture({ accessToken: 'after-mfa' });
      stub.respondInOrder('mfaVerify', [{ body }]);
      const verified = await mfa('123456', {
        Cookie: `${BFF_COOKIES.mfa}=${mfaCookie}`,
      }).expect(200);
      sessionResponseSchema.parse(verified.body);
      expect(stub.callsTo('mfaVerify')[0].body).toEqual({
        mfaToken: 'MFA-CHALLENGE-SECRET',
        code: '123456',
      });
      const cookies = cookiesOf(verified);
      expect(cookies[BFF_COOKIES.session]).toBeDefined();
      expect(cookies[BFF_COOKIES.csrf]).toBeDefined();
      expect(
        setCookieLines(verified).find((l) =>
          l.startsWith(`${BFF_COOKIES.mfa}=`),
        ),
      ).toMatch(/Max-Age=0/);
      expect(await bffKeys(ctx.redis, 'bff:mfa*')).toHaveLength(0);
      expect(await bffKeys(ctx.redis, 'bff:sess:*')).toHaveLength(1);
    });

    it('S48 AS-49: verify without a pending challenge is 409 and never reaches the identity service', async () => {
      const none = await mfa('123456').expect(409);
      expect(parseProblem(none.body).code).toBe('mfa_not_pending');
      const forged = await mfa('123456', {
        Cookie: `${BFF_COOKIES.mfa}=${'B'.repeat(43)}`,
      }).expect(409);
      expect(parseProblem(forged.body).code).toBe('mfa_not_pending');
      const active = await signIn(ctx, stub);
      await mfa('123456', { Cookie: active.cookie }).expect(409); // an active session is not a pending login
      const { mfaCookie } = await startChallenge();
      ctx.clock.advance(5 * 60_000 + 1);
      await mfa('123456', { Cookie: `${BFF_COOKIES.mfa}=${mfaCookie}` }).expect(
        409,
      );
      expect(stub.callsTo('mfaVerify')).toHaveLength(0);
    });

    it('S48 AS-49: a wrong code keeps the pending state; a spent challenge deletes it and answers invalid_token', async () => {
      const { mfaCookie } = await startChallenge();
      const cookie = `${BFF_COOKIES.mfa}=${mfaCookie}`;
      stub.respondInOrder('mfaVerify', [
        { status: 401, body: { code: 'invalid_mfa_code' } },
        { status: 401, body: { code: 'invalid_mfa_challenge' } },
      ]);
      const wrong = await mfa('000000', { Cookie: cookie }).expect(401);
      expect(parseProblem(wrong.body).code).toBe('invalid_mfa_code');
      expect(await bffKeys(ctx.redis, 'bff:mfa:*')).toHaveLength(1);
      expect(await bffKeys(ctx.redis, 'bff:mfa-lock:*')).toHaveLength(0); // the lock is released
      const spent = await mfa('000000', { Cookie: cookie }).expect(401);
      expect(parseProblem(spent.body).code).toBe('invalid_token');
      expect(await bffKeys(ctx.redis, 'bff:mfa*')).toHaveLength(0);
      await mfa('000000', { Cookie: cookie }).expect(409);
    });

    it('S48 AS-50: two simultaneous verifies with the right code: one session, one 409', async () => {
      const { mfaCookie } = await startChallenge();
      const cookie = `${BFF_COOKIES.mfa}=${mfaCookie}`;
      stub.respond('mfaVerify', {
        body: identitySessionFixture(),
        delayMs: 150,
      });
      const [a, b] = await Promise.all([
        mfa('123456', { Cookie: cookie }, ctx),
        mfa('123456', { Cookie: cookie }, second),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(stub.callsTo('mfaVerify')).toHaveLength(1);
      expect(await bffKeys(ctx.redis, 'bff:sess:*')).toHaveLength(1);
    });
  });

  describe('current session and expiry (US4)', () => {
    it('S48 AS-51: GET /session answers the user; no cookie, a random cookie and the stored hash as cookie are 401 unauthenticated', async () => {
      const who = await signIn(ctx, stub);
      const ok = await ctx
        .http()
        .get('/api/bff/session')
        .set('Cookie', who.cookie)
        .expect(200);
      expect(sessionResponseSchema.parse(ok.body).user.id).toBe(who.userId);
      expect(ok.headers['cache-control']).toBe('no-store');
      for (const cookie of [
        undefined,
        `${BFF_COOKIES.session}=${'C'.repeat(43)}`,
        `${BFF_COOKIES.session}=${sha256(who.sessionCookie)}`,
      ]) {
        const r = ctx.http().get('/api/bff/session');
        const res = await (cookie ? r.set('Cookie', cookie) : r).expect(401);
        expect(parseProblem(res.body).code).toBe('unauthenticated');
        if (cookie)
          expect(
            setCookieLines(res).find((l) =>
              l.startsWith(`${BFF_COOKIES.session}=`),
            ),
          ).toMatch(/Max-Age=0/);
      }
    });

    it('S48 AS-52: an idle session ends after 24 h; use within 24 h extends the idle deadline, written at most once a minute', async () => {
      const who = await signIn(ctx, stub);
      const store = ctx.app.get(SessionStore);
      const write = jest.spyOn(store, 'compareAndSet');
      for (let i = 0; i < 5; i++) {
        await ctx
          .http()
          .get('/api/bff/session')
          .set('Cookie', who.cookie)
          .expect(200);
        ctx.clock.advance(10_000);
      }
      expect(write.mock.calls.length).toBeLessThanOrEqual(1); // 50 s of use: at most one idle extension
      ctx.clock.advance(23 * HOUR);
      await ctx
        .http()
        .get('/api/bff/session')
        .set('Cookie', who.cookie)
        .expect(200);
      ctx.clock.advance(23 * HOUR); // 46 h since login, 23 h since last use: still active
      await ctx
        .http()
        .get('/api/bff/session')
        .set('Cookie', who.cookie)
        .expect(200);
      ctx.clock.advance(24 * HOUR + 1_000);
      const ended = await ctx
        .http()
        .get('/api/bff/session')
        .set('Cookie', who.cookie)
        .expect(401);
      expect(parseProblem(ended.body).code).toBe('session_expired');
      expect(await rawRecord(who.sessionCookie)).toBeNull();
      expect(
        setCookieLines(ended).find((l) =>
          l.startsWith(`${BFF_COOKIES.session}=`),
        ),
      ).toMatch(/Max-Age=0/);
      expect(
        setCookieLines(ended).find((l) => l.startsWith(`${BFF_COOKIES.csrf}=`)),
      ).toMatch(/Max-Age=0/);
    });

    it('S48 AS-52: the 30-day limit holds however often the session is used', async () => {
      const who = await signIn(ctx, stub);
      let status = 200;
      for (let step = 0; step < 40 && status === 200; step++) {
        ctx.clock.advance(20 * HOUR);
        status = (
          await ctx.http().get('/api/bff/session').set('Cookie', who.cookie)
        ).status;
      }
      expect(status).toBe(401);
      expect(ctx.clock.nowMs() - T0.getTime()).toBeGreaterThanOrEqual(30 * DAY);
      expect(ctx.clock.nowMs() - T0.getTime()).toBeLessThanOrEqual(
        30 * DAY + 20 * HOUR,
      );
    });

    it('S48 AS-52: an ended session is served as anonymous on public reads', async () => {
      const product = seedProduct(stub);
      const who = await signIn(ctx, stub);
      ctx.clock.advance(25 * HOUR);
      const res = await page(product.id, who.cookie).expect(200);
      expect(res.body.chatUnread).toBeNull();
      for (const call of stub.calls)
        expect(call.headers.authorization).toBeUndefined();
      expect(await rawRecord(who.sessionCookie)).toBeNull();
    });
  });

  describe('refresh (US4)', () => {
    const refreshed = (token = 'rotated-access') =>
      identitySessionFixture({
        accessToken: token,
        refreshToken: 'rotated-refresh',
      });

    it('S48 AS-53: a token with 20 s left is refreshed once and the new token is forwarded; one with more than 30 s is used as is', async () => {
      const product = seedProduct(stub);
      const near = await signIn(ctx, stub, {
        accessToken: 'near-expiry',
        refreshToken: 'refresh-1',
        expiresIn: 20,
      });
      stub.respondInOrder('refresh', [{ body: refreshed() }]);
      await page(product.id, near.cookie).expect(200);
      expect(stub.callsTo('refresh')).toHaveLength(1);
      expect(stub.callsTo('refresh')[0].body).toEqual({
        refreshToken: 'refresh-1',
      });
      expect(stub.callsTo('flags')[0].headers.authorization).toBe(
        'Bearer rotated-access',
      );
      await page(product.id, near.cookie).expect(200); // now valid for 300 s
      expect(stub.callsTo('refresh')).toHaveLength(1);

      stub.reset();
      stub.products.set(product.id, product);
      const healthy = await signIn(ctx, stub, {
        accessToken: 'healthy',
        expiresIn: 300,
      });
      ctx.clock.advance(200_000); // 100 s left
      await page(product.id, healthy.cookie).expect(200);
      expect(stub.callsTo('refresh')).toHaveLength(0);
      expect(stub.callsTo('flags')[0].headers.authorization).toBe(
        'Bearer healthy',
      );
    });

    it('S48 AS-54: 20 simultaneous requests on one expired session across two instances cause exactly one refresh', async () => {
      const product = seedProduct(stub);
      const who = await signIn(ctx, stub, {
        accessToken: 'stale',
        refreshToken: 'only-once',
        expiresIn: 300,
      });
      ctx.clock.advance(400_000);
      stub.respond('refresh', { body: refreshed(), delayMs: 120 });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          page(product.id, who.cookie, i % 2 ? second : ctx).then((r) => r),
        ),
      );
      for (const r of results) expect(r.status).toBe(200);
      expect(stub.callsTo('refresh')).toHaveLength(1);
      expect(
        stub.calls.filter((c) =>
          JSON.stringify(c.body ?? '').includes('only-once'),
        ),
      ).toHaveLength(1);
      for (const call of [
        ...stub.callsTo('flags'),
        ...stub.callsTo('chatUnread'),
      ])
        expect(call.headers.authorization).toBe('Bearer rotated-access');
      expect(await bffKeys(ctx.redis, 'bff:refresh:*')).toHaveLength(0); // the lock is released
    });

    it('S48 AS-55: a rejected refresh ends the session: 401 session_expired, cookies cleared, record gone, never retried', async () => {
      const product = seedProduct(stub);
      const who = await signIn(ctx, stub, { expiresIn: 20 });
      stub.respond('refresh', {
        status: 401,
        body: { code: 'invalid_refresh_token' },
      });
      const res = await page(product.id, who.cookie).expect(401);
      expect(parseProblem(res.body).code).toBe('session_expired');
      expect(
        setCookieLines(res).find((l) =>
          l.startsWith(`${BFF_COOKIES.session}=`),
        ),
      ).toMatch(/Max-Age=0/);
      expect(await rawRecord(who.sessionCookie)).toBeNull();
      expect(stub.callsTo('refresh')).toHaveLength(1);
      const later = await page(product.id, who.cookie).expect(200); // anonymous now
      expect(later.body.chatUnread).toBeNull();
      expect(stub.callsTo('refresh')).toHaveLength(1);
    });

    it('S48 AS-56: identity down on refresh: a still-valid token proceeds and the session is kept; an expired one is 503 session_unavailable', async () => {
      const product = seedProduct(stub);
      const who = await signIn(ctx, stub, {
        accessToken: 'still-valid',
        expiresIn: 20,
      });
      stub.respond('refresh', { status: 503, body: {} });
      await page(product.id, who.cookie).expect(200);
      expect(stub.callsTo('flags')[0].headers.authorization).toBe(
        'Bearer still-valid',
      );
      expect(stub.callsTo('refresh')).toHaveLength(1); // one attempt, no retry
      expect(await rawRecord(who.sessionCookie)).not.toBeNull();

      ctx.clock.advance(60_000); // the token has expired
      stub.respond('refresh', { body: {}, delayMs: 3_000 }); // identity times out
      const res = await page(product.id, who.cookie).expect(503);
      expect(parseProblem(res.body).code).toBe('session_unavailable');
      expect(res.headers['retry-after']).toBeDefined();
      expect(await rawRecord(who.sessionCookie)).not.toBeNull();
      expect(stub.callsTo('refresh')).toHaveLength(2); // exactly one attempt per request
    });

    it('S48 AS-57: a failed store write after rotation is retried; three failures end the session fail-closed', async () => {
      const product = seedProduct(stub);
      const store = ctx.app.get(SessionStore);
      const who = await signIn(ctx, stub, { expiresIn: 20 });
      stub.respondInOrder('refresh', [{ body: refreshed('after-retry') }]);
      const real = store.compareAndSet.bind(store);
      const write = jest
        .spyOn(store, 'compareAndSet')
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation(real);
      await page(product.id, who.cookie).expect(200);
      expect(write).toHaveBeenCalledTimes(2);
      expect(stub.callsTo('flags')[0].headers.authorization).toBe(
        'Bearer after-retry',
      );
      expect(await rawRecord(who.sessionCookie)).not.toBeNull();

      write.mockReset();
      const other = await signIn(ctx, stub, { expiresIn: 20 });
      stub.respondInOrder('refresh', [{ body: refreshed('lost') }]);
      write.mockRejectedValue(new Error('redis down'));
      const res = await page(product.id, other.cookie).expect(503);
      expect(parseProblem(res.body).code).toBe('session_unavailable');
      expect(write).toHaveBeenCalledTimes(3);
      write.mockRestore();
      expect(await rawRecord(other.sessionCookie)).toBeNull();
      const refreshCalls = stub.callsTo('refresh').length;
      await page(product.id, other.cookie).expect(200); // anonymous; the spent refresh token is never presented again
      expect(stub.callsTo('refresh')).toHaveLength(refreshCalls);
    });

    it('S48 AS-63: a redirect from the identity service is not followed and the refresh token reaches nobody else', async () => {
      const product = seedProduct(stub);
      const who = await signIn(ctx, stub, { expiresIn: 20 });
      stub.respond('refresh', { redirect: `${tripwire.url}/steal` });
      await page(product.id, who.cookie).expect(200); // identity "down" with a valid token: proceeds
      expect(tripwire.requests).toHaveLength(0);
    });
  });

  describe('logout and CSRF (US4)', () => {
    const logout = (headers: Record<string, string> = {}) =>
      ctx.http().post('/api/bff/session/logout').set(headers).send();

    it('S48 AS-58: logout needs the CSRF token; with it the record is deleted, cookies cleared and identity told; replays are 204 without a call', async () => {
      const who = await signIn(ctx, stub, { accessToken: 'to-revoke' });
      const denied = await logout({ Cookie: who.cookie }).expect(403);
      expect(parseProblem(denied.body).code).toBe('csrf_invalid');
      expect(await rawRecord(who.sessionCookie)).not.toBeNull();

      const ok = await logout({
        Cookie: who.cookie,
        'X-CSRF-Token': who.csrf,
      }).expect(204);
      for (const name of [
        BFF_COOKIES.session,
        BFF_COOKIES.csrf,
        BFF_COOKIES.mfa,
      ])
        expect(
          setCookieLines(ok).find((l) => l.startsWith(`${name}=`)),
        ).toMatch(/Max-Age=0/);
      expect(await rawRecord(who.sessionCookie)).toBeNull();
      expect(stub.callsTo('logout')).toHaveLength(1);
      expect(stub.callsTo('logout')[0].headers.authorization).toBe(
        'Bearer to-revoke',
      );

      await logout({ Cookie: who.cookie, 'X-CSRF-Token': who.csrf }).expect(
        204,
      ); // replay
      await logout().expect(204); // no cookie
      expect(stub.callsTo('logout')).toHaveLength(1);

      const down = await signIn(ctx, stub);
      stub.respond('logout', { status: 503, body: {} });
      await logout({ Cookie: down.cookie, 'X-CSRF-Token': down.csrf }).expect(
        204,
      );
      expect(await rawRecord(down.sessionCookie)).toBeNull();
    });

    it('S48 AS-59: a missing, mismatched or foreign CSRF token is 403; GET and bearer-only requests are exempt', async () => {
      const a = await signIn(ctx, stub);
      const b = await signIn(ctx, stub);
      const csrfCookie = (token: string) =>
        `${BFF_COOKIES.session}=${a.sessionCookie}; ${BFF_COOKIES.csrf}=${token}`;
      const cases: [string, Record<string, string>][] = [
        ['no header', { Cookie: a.cookie }],
        [
          'header differs from the cookie',
          { Cookie: a.cookie, 'X-CSRF-Token': b.csrf },
        ],
        [
          'issued for another session',
          { Cookie: csrfCookie(b.csrf), 'X-CSRF-Token': b.csrf },
        ],
        ['not a token', { Cookie: csrfCookie('nope'), 'X-CSRF-Token': 'nope' }],
      ];
      for (const [, headers] of cases) {
        const res = await logout(headers).expect(403);
        expect(parseProblem(res.body).code).toBe('csrf_invalid');
      }
      expect(await rawRecord(a.sessionCookie)).not.toBeNull();
      await ctx
        .http()
        .get('/api/bff/session')
        .set('Cookie', a.cookie)
        .expect(200); // GET exempt
      await logout({ Authorization: 'Bearer native-token' }).expect(204); // bearer only: nothing to protect
      await logout({ Cookie: a.cookie, 'X-CSRF-Token': a.csrf }).expect(204);
    });

    it('S48 AS-60: a request with both the session cookie and an Authorization header is 400 ambiguous_credentials with no upstream call', async () => {
      const who = await signIn(ctx, stub);
      stub.calls.length = 0;
      const product = seedProduct(stub);
      for (const res of [
        await page(product.id, who.cookie)
          .set('Authorization', 'Bearer x')
          .expect(400),
        await ctx
          .http()
          .get('/api/bff/session')
          .set({ Cookie: who.cookie, Authorization: 'Bearer x' })
          .expect(400),
        await logout({
          Cookie: who.cookie,
          Authorization: 'Bearer x',
          'X-CSRF-Token': who.csrf,
        }).expect(400),
      ])
        expect(parseProblem(res.body).code).toBe('ambiguous_credentials');
      expect(stub.calls).toHaveLength(0);
    });
  });

  describe('forced refresh (W01 B-2)', () => {
    const refreshRoute = (cookie?: string, csrf?: string, app = ctx) => {
      const r = app.http().post('/api/bff/session/refresh');
      if (cookie) r.set('Cookie', cookie);
      if (csrf) r.set('X-CSRF-Token', csrf);
      return r.set('Origin', ALLOWED_ORIGIN).send();
    };

    it('bff-session: refresh re-reads the identity so a changed role is visible, and rotates the stored tokens', async () => {
      const who = await signIn(ctx, stub, { role: 'USER' });
      stub.respondInOrder('refresh', [
        {
          body: identitySessionFixture({
            userId: who.userId,
            role: 'SELLER',
            accessToken: 'after-promotion',
            refreshToken: 'rotated',
          }),
        },
      ]);
      const res = await refreshRoute(who.cookie, who.csrf).expect(200);
      const session = sessionResponseSchema.parse(res.body);
      expect(session.user.role).toBe('SELLER');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify([res.body, res.headers])).not.toContain(
        'after-promotion',
      );
      expect(stub.callsTo('refresh')).toHaveLength(1);
      expect(stub.callsTo('refresh')[0].body).toEqual({
        refreshToken: who.refreshToken,
      });
      const current = await ctx
        .http()
        .get('/api/bff/session')
        .set('Cookie', who.cookie)
        .expect(200);
      expect(current.body.user.role).toBe('SELLER');
    });

    it('bff-session: refresh without a session cookie is 401 unauthenticated and calls nobody', async () => {
      const res = await refreshRoute().expect(401);
      expect(parseProblem(res.body).code).toBe('unauthenticated');
      expect(stub.callsTo('refresh')).toHaveLength(0);
    });

    it('bff-session: refresh with a missing or wrong CSRF token is 403 csrf_invalid', async () => {
      const who = await signIn(ctx, stub);
      for (const csrf of [undefined, 'not-the-token']) {
        const res = await refreshRoute(who.cookie, csrf).expect(403);
        expect(parseProblem(res.body).code).toBe('csrf_invalid');
      }
      expect(stub.callsTo('refresh')).toHaveLength(0);
    });

    it('bff-session: concurrent refresh calls cause one upstream refresh and all see the new role', async () => {
      const who = await signIn(ctx, stub);
      stub.respond('refresh', {
        body: identitySessionFixture({
          userId: who.userId,
          role: 'ADMIN',
          refreshToken: 'only-rotation',
        }),
        delayMs: 120,
      });
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          refreshRoute(who.cookie, who.csrf, i % 2 ? second : ctx),
        ),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.body.user.role).toBe('ADMIN');
      }
      expect(stub.callsTo('refresh')).toHaveLength(1);
    });

    it('bff-session: a rejected refresh ends the session with 401 session_expired and cleared cookies', async () => {
      const who = await signIn(ctx, stub);
      stub.respond('refresh', {
        status: 401,
        body: { code: 'invalid_refresh_token' },
      });
      const res = await refreshRoute(who.cookie, who.csrf).expect(401);
      expect(parseProblem(res.body).code).toBe('session_expired');
      expect(
        setCookieLines(res).find((l) =>
          l.startsWith(`${BFF_COOKIES.session}=`),
        ),
      ).toMatch(/Max-Age=0/);
    });

    it('bff-session: refresh with the session store down is 503 session_unavailable', async () => {
      const down = await createBffApp({
        upstreamUrl: stub.url,
        clock: ctx.clock,
      });
      try {
        const who = await signIn(down, stub);
        down.redis.client.disconnect();
        const res = await refreshRoute(who.cookie, who.csrf, down).expect(503);
        expect(parseProblem(res.body).code).toBe('session_unavailable');
      } finally {
        await down.close().catch(() => undefined);
      }
    });
  });

  describe('failure modes and isolation (US4)', () => {
    it('S48 AS-61: with the session store down anonymous requests are served, cookie requests are 503 session_unavailable, readiness is unaffected', async () => {
      const down = await createBffApp({
        upstreamUrl: stub.url,
        clock: ctx.clock,
      });
      try {
        const product = seedProduct(stub);
        const who = await signIn(down, stub);
        down.redis.client.disconnect();
        await page(product.id, undefined, down).expect(200);
        const res = await page(product.id, who.cookie, down).expect(503);
        expect(parseProblem(res.body).code).toBe('session_unavailable');
        expect(res.headers['retry-after']).toBeDefined();
        const current = await down
          .http()
          .get('/api/bff/session')
          .set('Cookie', who.cookie)
          .expect(503);
        expect(parseProblem(current.body).code).toBe('session_unavailable');
        await down.http().get('/health/ready').expect(200);
      } finally {
        await down.close().catch(() => undefined);
      }
    });

    it('S48 AS-62: interleaved users only ever see their own token; forged and logged-out cookies never give a signed-in view', async () => {
      const product = seedProduct(stub);
      stub.respond('flags', (call) => ({
        body: {
          version: 1,
          flags: {
            who: {
              variant: String(call.headers.authorization ?? 'anonymous'),
              value: true,
            },
          },
        },
      }));
      const a = await signIn(ctx, stub, { accessToken: 'token-of-A' });
      const b = await signIn(ctx, stub, { accessToken: 'token-of-B' });
      for (const [who, expected] of [
        [a, 'A'],
        [b, 'B'],
        [b, 'B'],
        [a, 'A'],
      ] as const) {
        const res = await page(
          product.id,
          who.cookie,
          expected === 'A' ? ctx : second,
        ).expect(200);
        expect(res.body.flags.flags.who.variant).toBe(
          `Bearer token-of-${expected}`,
        );
      }
      for (const call of [...stub.callsTo('chatUnread')])
        expect(['Bearer token-of-A', 'Bearer token-of-B']).toContain(
          call.headers.authorization,
        );
      const forged = await page(
        product.id,
        `${BFF_COOKIES.session}=${'D'.repeat(43)}`,
      ).expect(200);
      expect(forged.body.flags.flags.who.variant).toBe('anonymous');
      expect(forged.body.chatUnread).toBeNull();
      await ctx
        .http()
        .post('/api/bff/session/logout')
        .set({ Cookie: a.cookie, 'X-CSRF-Token': a.csrf })
        .expect(204);
      const loggedOut = await page(product.id, a.cookie).expect(200);
      expect(loggedOut.body.flags.flags.who.variant).toBe('anonymous');
    });

    it('S48 AS-45: login is rate limited fail closed: with the limiter store down it is refused, not allowed through', async () => {
      const down = await createBffApp({
        upstreamUrl: stub.url,
        clock: ctx.clock,
      });
      try {
        down.redis.client.disconnect();
        const res = await login({}, {}, down).expect(503);
        expect(parseProblem(res.body).code).toBe('rate_limiter_unavailable');
        expect(stub.callsTo('login')).toHaveLength(0);
      } finally {
        await down.close().catch(() => undefined);
      }
    });
  });
});
