import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { authStore, decodeJwt } from './testing/auth-app';
import { codeAt, enableSecondFactor, flushRedis } from './testing/mfa-fixtures';
import {
  FRONT,
  OidcTestApp,
  cookieValue,
  createOidcApp,
  setCookies,
  signIn,
} from './testing/oidc-fixtures';

describe('Sign in with Google for a user with a second factor', () => {
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

  const claims = {
    sub: 'g-mfa-1',
    email: 'fed-mfa@example.com',
    email_verified: true,
  };
  const sessions = async () =>
    (await authStore(app.t.app).all()).filter((i) =>
      String(i.PK).startsWith('SESSION#'),
    );
  const verify = (body: object, headers: Record<string, string> = {}) =>
    app.t.http().post('/api/auth/mfa/verify').set(headers).send(body);

  /** A Google account that exists and then turns the second factor on; returns the secret. */
  async function enrolledGoogleUser() {
    await signIn(app, claims);
    const [row] = await app.t.app
      .get(Sequelize)
      .query<{ id: string }>(`SELECT "id" FROM "User"`, {
        type: QueryTypes.SELECT,
      });
    const factor = await enableSecondFactor(app.t, row.id);
    return { userId: row.id, ...factor };
  }

  /** Signs in again and returns the challenge cookie of the redirect. */
  async function challenged(returnTo = '/account') {
    const { res } = await signIn(app, claims, { returnTo });
    const cookies = setCookies(res);
    return {
      res,
      cookies,
      token: cookies['__Host-mfa-challenge']
        ? cookieValue(cookies['__Host-mfa-challenge'])
        : undefined,
    };
  }

  it('S02 AS-54: stops at /login/mfa with a challenge cookie and no session, then the code completes it with amr fed,otp,mfa', async () => {
    const { secret } = await enrolledGoogleUser();
    const before = (await sessions()).length;

    const { res, cookies, token } = await challenged();

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${FRONT}/login/mfa?returnTo=${encodeURIComponent('/account')}`,
    );
    const line = cookies['__Host-mfa-challenge'];
    expect(line).toContain('HttpOnly');
    expect(line).toContain('Secure');
    expect(line).toContain('SameSite=Lax');
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).toContain('Max-Age=300');
    expect(cookies['__Host-access']).toBeUndefined();
    expect(cookies['__Host-refresh']).toBeUndefined();
    expect((await sessions()).length).toBe(before);
    expect(res.headers.location).not.toContain(token!);

    const done = await verify(
      { code: codeAt(app.t, secret), delivery: 'cookie' },
      { Origin: FRONT, Cookie: `__Host-mfa-challenge=${token}` },
    ).expect(200);
    const set = setCookies(done);
    expect(set['__Host-access']).toBeDefined();
    expect(set['__Host-mfa-challenge']).toMatch(/Expires=Thu, 01 Jan 1970/);
    const { claims: jwt } = decodeJwt(cookieValue(set['__Host-access']));
    expect(jwt.amr).toEqual(['fed', 'otp', 'mfa']);
    expect((await sessions()).length).toBe(before + 1);
  });

  it('S02 AS-55: a foreign origin is 403 and leaves the challenge intact; no cookie and no token is 401 invalid_mfa_challenge', async () => {
    const { secret } = await enrolledGoogleUser();
    const { token } = await challenged();
    const cookie = `__Host-mfa-challenge=${token}`;

    const evil = await verify(
      { code: codeAt(app.t, secret), delivery: 'cookie' },
      { Origin: 'https://evil.example', Cookie: cookie },
    ).expect(403);
    expect(evil.body.code).toBe('origin_not_allowed');

    const none = await verify(
      { code: codeAt(app.t, secret), delivery: 'cookie' },
      { Origin: FRONT },
    ).expect(401);
    expect(none.body.code).toBe('invalid_mfa_challenge');

    await verify(
      { code: codeAt(app.t, secret), delivery: 'cookie' },
      { Origin: FRONT, Cookie: cookie },
    ).expect(200);
  });

  it('S02 AS-55: an expired challenge cookie is 401, a body mfaToken wins over the cookie, and a burned challenge clears the cookie', async () => {
    const { secret } = await enrolledGoogleUser();
    const first = await challenged();
    const second = await challenged();

    // The body token (valid) wins over a garbage cookie.
    await verify(
      {
        mfaToken: first.token,
        code: codeAt(app.t, secret),
        delivery: 'cookie',
      },
      { Origin: FRONT, Cookie: '__Host-mfa-challenge=garbage' },
    ).expect(200);

    // Three wrong codes burn the second challenge; the response that burns it clears the cookie.
    const cookie = `__Host-mfa-challenge=${second.token}`;
    for (let i = 0; i < 3; i++)
      await verify(
        { code: '000000', delivery: 'cookie' },
        { Origin: FRONT, Cookie: cookie },
      ).expect(401);
    const burned = await verify(
      { code: '000000', delivery: 'cookie' },
      { Origin: FRONT, Cookie: cookie },
    ).expect(401);
    expect(burned.body.code).toBe('invalid_mfa_challenge');
    expect(setCookies(burned)['__Host-mfa-challenge']).toMatch(
      /Expires=Thu, 01 Jan 1970/,
    );

    // Past its five minutes the challenge is dead.
    const third = await challenged();
    app.t.clock.advance(400_000); // past the 5-minute lifetime and the clock-skew tolerance
    const expired = await verify(
      { code: codeAt(app.t, secret), delivery: 'cookie' },
      { Origin: FRONT, Cookie: `__Host-mfa-challenge=${third.token}` },
    ).expect(401);
    expect(expired.body.code).toBe('invalid_mfa_challenge');
  });
});
