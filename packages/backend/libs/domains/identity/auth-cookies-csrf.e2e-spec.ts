import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import {
  authStore,
  AuthTestApp,
  createAuthApp,
  TEST_PASSWORD,
} from './testing/auth-app';
import { flushRedis } from './testing/mfa-fixtures';

const FRONT = 'http://localhost:3000';
const EVIL = 'https://evil.example';

describe('Cookie sessions and CSRF', () => {
  let t: AuthTestApp;
  let store: ReturnType<typeof authStore>;

  beforeAll(async () => {
    t = await createAuthApp();
    store = authStore(t.app);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
  });

  type Jar = Record<string, string>;
  const setCookies = (res: { headers: Record<string, unknown> }) =>
    (res.headers['set-cookie'] ?? []) as string[];
  const jarOf = (res: { headers: Record<string, unknown> }): Jar =>
    Object.fromEntries(
      setCookies(res).map((c) => {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        return [pair.slice(0, i), pair.slice(i + 1)];
      }),
    );
  const cookieHeader = (jar: Jar, names = Object.keys(jar)) =>
    names.map((n) => `${n}=${jar[n]}`).join('; ');

  const cookieLogin = async (email?: string) => {
    const user = await t.seedUser(email ? { email } : {});
    const res = await t
      .http()
      .post('/api/auth/login')
      .set('Origin', FRONT)
      .send({ email: user.email, password: TEST_PASSWORD, delivery: 'cookie' })
      .expect(200);
    return { user, res, jar: jarOf(res), sid: res.body.sessionId as string };
  };
  const post = (
    path: string,
    jar: Jar,
    headers: Record<string, string> = {},
    names?: string[],
  ) => t.http().post(path).set('Cookie', cookieHeader(jar, names)).set(headers);
  const codeOf = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body).code;

  it('S01 AS-46: cookie delivery sets the three cookies with their attributes and puts no token in the body', async () => {
    const { res, sid } = await cookieLogin();

    expect(res.body).toEqual({
      sessionId: sid,
      user: expect.objectContaining({ id: expect.any(String) }),
      accessTokenExpiresIn: 300,
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /eyJ|refreshToken|accessToken"/,
    );
    const cookies = setCookies(res);
    const named = (name: string) =>
      cookies.find((c) => c.startsWith(`${name}=`))!;
    for (const name of ['__Host-access', '__Host-refresh', '__Host-csrf']) {
      expect(named(name)).toMatch(/; Path=\/(;|$)/);
      expect(named(name)).toContain('Secure');
      expect(named(name)).toContain('SameSite=Lax');
      expect(named(name)).not.toContain('Domain=');
      expect(named(name)).toMatch(/Max-Age=\d+/);
    }
    expect(named('__Host-access')).toContain('HttpOnly');
    expect(named('__Host-access')).toContain('Max-Age=300;');
    expect(named('__Host-refresh')).toContain('HttpOnly');
    expect(named('__Host-refresh')).toContain(`Max-Age=${30 * 86_400}`);
    expect(named('__Host-csrf')).not.toContain('HttpOnly');
  });

  it('S01 AS-86: register, log in, see the account and sessions, end another device, log out; no token is script-readable', async () => {
    const email = 'journey@example.com';
    await t
      .http()
      .post('/api/auth/register')
      .send({ email, password: TEST_PASSWORD })
      .expect(202);
    const signIn = () =>
      t
        .http()
        .post('/api/auth/login')
        .set('Origin', FRONT)
        .send({ email, password: TEST_PASSWORD, delivery: 'cookie' })
        .expect(200);
    const login = await signIn();
    const other = await signIn();
    const jar = jarOf(login);
    const sid = login.body.sessionId as string;
    const otherSid = other.body.sessionId as string;

    // The script-readable surface: the body and every cookie without HttpOnly.
    const readable = [
      JSON.stringify(login.body),
      ...setCookies(login).filter((c) => !c.includes('HttpOnly')),
    ].join('\n');
    expect(readable).not.toContain(jar['__Host-access']);
    expect(readable).not.toContain(jar['__Host-refresh']);
    expect(readable).not.toMatch(/eyJ/);

    const me = await t
      .http()
      .get('/api/auth/me')
      .set('Cookie', cookieHeader(jar))
      .expect(200);
    expect(JSON.stringify(me.body)).toContain(email);

    const list = await t
      .http()
      .get('/api/auth/sessions')
      .set('Cookie', cookieHeader(jar))
      .expect(200);
    expect(list.body).toHaveLength(2);

    await t
      .http()
      .delete(`/api/auth/sessions/${otherSid}`)
      .set('Cookie', cookieHeader(jar))
      .set('X-CSRF-Token', jar['__Host-csrf'])
      .expect(204);
    expect((await store.session(otherSid))?.revokedAt).toEqual(
      expect.any(String),
    );

    await post('/api/auth/logout', jar, {
      'X-CSRF-Token': jar['__Host-csrf'],
    }).expect(204);
    expect((await store.session(sid))?.revokedAt).toEqual(expect.any(String));
  });

  it('S01 AS-47: a cookie-authenticated state change without the CSRF header is 403 csrf_invalid and changes nothing', async () => {
    const { jar, sid } = await cookieLogin();

    const res = await post('/api/auth/logout', jar).expect(403);

    expect(codeOf(res)).toBe('csrf_invalid');
    expect((await store.session(sid))?.revokedAt).toBeUndefined();
  });

  it('S01 AS-48: the matching token is accepted; a token of another session is not', async () => {
    const a = await cookieLogin();
    const b = await cookieLogin();

    const crossed = await post(
      '/api/auth/logout',
      { ...a.jar, '__Host-csrf': b.jar['__Host-csrf'] },
      { 'X-CSRF-Token': b.jar['__Host-csrf'] },
    ).expect(403);
    expect(codeOf(crossed)).toBe('csrf_invalid');
    expect((await store.session(a.sid))?.revokedAt).toBeUndefined();

    await post('/api/auth/logout', a.jar, {
      'X-CSRF-Token': a.jar['__Host-csrf'],
    }).expect(204);
    expect((await store.session(a.sid))?.revokedAt).toEqual(expect.any(String));
  });

  it('S01 AS-49: a Bearer-authenticated request needs no CSRF header', async () => {
    const user = await t.seedUser();
    const login = await t
      .http()
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    await t
      .http()
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.body.accessToken.token}`)
      .expect(204);
  });

  it('S01 AS-50: a foreign Origin, or cross-site fetch metadata without Origin, is refused; the front-end origin passes', async () => {
    const { jar, sid } = await cookieLogin();
    const csrf = { 'X-CSRF-Token': jar['__Host-csrf'] };

    const foreign = await post('/api/auth/logout', jar, {
      ...csrf,
      Origin: EVIL,
    }).expect(403);
    expect(codeOf(foreign)).toBe('origin_not_allowed');
    const crossSite = await post('/api/auth/logout', jar, {
      ...csrf,
      'Sec-Fetch-Site': 'cross-site',
    }).expect(403);
    expect(codeOf(crossSite)).toBe('origin_not_allowed');
    expect((await store.session(sid))?.revokedAt).toBeUndefined();

    await post('/api/auth/logout', jar, { ...csrf, Origin: FRONT }).expect(204);
  });

  it('S01 AS-51: cookie delivery from a foreign origin is 403, sets no cookie and creates no session', async () => {
    const user = await t.seedUser();
    const before = (await store.all()).length;

    const res = await t
      .http()
      .post('/api/auth/login')
      .set('Origin', EVIL)
      .send({ email: user.email, password: TEST_PASSWORD, delivery: 'cookie' })
      .expect(403);

    expect(codeOf(res)).toBe('origin_not_allowed');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await store.all()).length).toBe(before);
  });

  it.each([
    [
      '/api/auth/login',
      'application/x-www-form-urlencoded',
      'email=a%40b.c&password=x',
    ],
    ['/api/auth/login', 'text/plain', '{"email":"a@b.c","password":"x"}'],
    [
      '/api/auth/register',
      'application/x-www-form-urlencoded',
      'email=a%40b.c',
    ],
    ['/api/auth/register', 'text/plain', '{}'],
    [
      '/api/auth/refresh',
      'application/x-www-form-urlencoded',
      'refreshToken=x',
    ],
    ['/api/auth/refresh', 'text/plain', '{"refreshToken":"x"}'],
  ])(
    'S01 AS-52: %s with %s is 415 unsupported_media_type',
    async (path, type, body) => {
      const res = await t
        .http()
        .post(path)
        .set('Content-Type', type)
        .send(body)
        .expect(415);

      expect(codeOf(res)).toBe('unsupported_media_type');
    },
  );

  it('S01 AS-54: cookie-mode refresh rotates all three cookies without a token in the body; a CSRF rejection consumes nothing', async () => {
    const { jar, sid } = await cookieLogin();
    const refreshOnly = ['__Host-refresh', '__Host-csrf'];

    const rejected = await post(
      '/api/auth/refresh',
      jar,
      {},
      refreshOnly,
    ).expect(403);
    expect(codeOf(rejected)).toBe('csrf_invalid');

    const res = await post(
      '/api/auth/refresh',
      jar,
      { 'X-CSRF-Token': jar['__Host-csrf'] },
      refreshOnly,
    ).expect(200);

    expect(res.body).toMatchObject({ sessionId: sid });
    expect(JSON.stringify(res.body)).not.toMatch(
      /eyJ|refreshToken|accessToken"/,
    );
    const next = jarOf(res);
    expect(Object.keys(next).sort()).toEqual([
      '__Host-access',
      '__Host-csrf',
      '__Host-refresh',
    ]);
    expect(next['__Host-refresh']).not.toBe(jar['__Host-refresh']);
    // The new token works, the spent one is reuse.
    await post(
      '/api/auth/refresh',
      next,
      { 'X-CSRF-Token': next['__Host-csrf'] },
      refreshOnly,
    ).expect(200);
  });

  it('S01 AS-55: cookie-mode logout clears all three cookies with the same attributes', async () => {
    const { jar } = await cookieLogin();

    const res = await post('/api/auth/logout', jar, {
      'X-CSRF-Token': jar['__Host-csrf'],
    }).expect(204);

    const cookies = setCookies(res);
    for (const name of ['__Host-access', '__Host-refresh', '__Host-csrf']) {
      const c = cookies.find((x) => x.startsWith(`${name}=;`))!;
      expect(c).toBeDefined();
      expect(c).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(c).toMatch(/; Path=\/(;|$)/);
      expect(c).toContain('Secure');
      expect(c).toContain('SameSite=Lax');
    }
  });

  it.each(['logout', 'logout-all', 'refresh'])(
    'S01 AS-56: GET /api/auth/%s changes nothing',
    async (route) => {
      const { jar, sid } = await cookieLogin();

      const res = await t
        .http()
        .get(`/api/auth/${route}`)
        .set('Cookie', cookieHeader(jar));

      expect([404, 405]).toContain(res.status);
      expect((await store.session(sid))?.revokedAt).toBeUndefined();
    },
  );
});
