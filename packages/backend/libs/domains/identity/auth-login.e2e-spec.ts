import { createHash } from 'node:crypto';
import * as argon2 from 'argon2';
import * as bcrypt from 'bcrypt';
import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  authSessionSchema,
  mfaChallengeSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import {
  AuthTestApp,
  createAuthApp,
  decodeJwt,
  TEST_PASSWORD,
} from './testing/auth-app';
import { PasswordHasher } from './infra/crypto/password-hasher';
import { USER_REPOSITORY, type UserRepository } from './domain/ports';

describe('Login', () => {
  let t: AuthTestApp;

  const login = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => t.http().post('/api/auth/login').set(headers).send(body);
  const auth = () => t.app.get(DynamoService);
  const authItems = async () =>
    (
      await auth().doc.send(
        new ScanCommand({ TableName: auth().table('Auth') }),
      )
    ).Items ?? [];

  beforeAll(async () => {
    t = await createAuthApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
  });

  it('S01 AS-10: body-delivery login returns the token profile, no-store, no cookie, a stored session and a refresh digest only', async () => {
    const user = await t.seedUser({ email: 'ten@example.com' });
    const userAgent = `agent/${'x'.repeat(300)}`;

    const res = await login(
      { email: 'ten@example.com', password: TEST_PASSWORD },
      { 'User-Agent': userAgent },
    ).expect(200);

    const body = authSessionSchema.parse(res.body);
    expect(body.accessToken.expiresIn).toBe(300);
    expect(body.user).toEqual({
      id: user.id,
      email: 'ten@example.com',
      role: 'USER',
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.headers['set-cookie']).toBeUndefined();

    const { header, claims } = decodeJwt(body.accessToken.token);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
    expect(header.kid).toEqual(expect.any(String));
    expect(claims).toMatchObject({
      iss: 'marketplace',
      aud: 'marketplace-api',
      sub: user.id,
      sid: body.sessionId,
      role: 'USER',
      amr: ['pwd'],
    });
    expect(claims.exp).toBe((claims.iat as number) + 300);
    expect(claims.nbf).toBe(claims.iat);
    expect(claims.jti).toEqual(expect.any(String));
    expect(JSON.stringify(claims)).not.toContain('ten@example.com');

    const { Item: session } = await auth().doc.send(
      new GetCommand({
        TableName: auth().table('Auth'),
        Key: { PK: `SESSION#${body.sessionId}`, SK: 'META' },
      }),
    );
    expect(session).toMatchObject({
      userId: user.id,
      device: userAgent.slice(0, 200),
    });
    expect(session?.device).toHaveLength(200);
    expect(session?.ip).toMatch(/127\.0\.0\.1$/);

    const digest = createHash('sha256')
      .update(body.refreshToken)
      .digest('base64url');
    const { Item: token } = await auth().doc.send(
      new GetCommand({
        TableName: auth().table('Auth'),
        Key: { PK: `RT#${digest}`, SK: 'META' },
      }),
    );
    expect(token).toMatchObject({ sid: body.sessionId, userId: user.id });
    expect(JSON.stringify(await authItems())).not.toContain(body.refreshToken);
  });

  it('S01 AS-11: unknown address and wrong password give identical 401s, each with exactly one verification', async () => {
    await t.seedUser({ email: 'known@example.com' });
    const verify = jest.spyOn(PasswordHasher.prototype, 'verify');

    const wrong = await login({
      email: 'known@example.com',
      password: 'not the password',
    }).expect(401);
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockClear();
    const unknown = await login({
      email: 'nobody@example.com',
      password: 'any password at all',
    }).expect(401);
    expect(verify).toHaveBeenCalledTimes(1);

    const pick = ({
      type,
      title,
      detail,
      code,
      status,
    }: Record<string, unknown>) => ({
      type,
      title,
      detail,
      code,
      status,
    });
    expect(pick(unknown.body)).toEqual(pick(wrong.body));
    expect(problemDetailsSchema.parse(wrong.body).code).toBe(
      'invalid_credentials',
    );
  });

  it.each(['registered', 'unregistered'])(
    'S01 AS-12: the 6th attempt for a %s address within 15 minutes is 429, even with the right password',
    async (kind) => {
      await t.seedUser({ email: 'target@example.com' });
      const email =
        kind === 'registered' ? 'target@example.com' : 'ghost@example.com';
      for (let i = 0; i < 5; i++)
        await login({ email, password: 'wrong password!' }).expect(401);

      const res = await login({ email, password: TEST_PASSWORD }).expect(429);

      expect(problemDetailsSchema.parse(res.body).code).toBe('rate_limited');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    },
  );

  it('S01 AS-12: the rate-limited answer has the same shape for registered and unregistered addresses', async () => {
    await t.seedUser({ email: 'shape@example.com' });
    const shape = async (email: string) => {
      for (let i = 0; i < 5; i++)
        await login({ email, password: 'wrong password!' }).expect(401);
      const res = await login({ email, password: 'wrong password!' }).expect(
        429,
      );
      const { type, title, status, code } = res.body;
      return { type, title, status, code, keys: Object.keys(res.body).sort() };
    };
    expect(await shape('shape@example.com')).toEqual(
      await shape('nobody-here@example.com'),
    );
  });

  it('S01 AS-13: a success clears the failure counter', async () => {
    await t.seedUser({ email: 'reset@example.com' });
    for (let i = 0; i < 4; i++)
      await login({
        email: 'reset@example.com',
        password: 'wrong password!',
      }).expect(401);
    await login({ email: 'reset@example.com', password: TEST_PASSWORD }).expect(
      200,
    );

    for (let i = 0; i < 4; i++)
      await login({
        email: 'reset@example.com',
        password: 'wrong password!',
      }).expect(401);
    // Without the reset this would be the 9th attempt of the window: refused with 429.
    await login({ email: 'reset@example.com', password: TEST_PASSWORD }).expect(
      200,
    );
  });

  it('S01 AS-14: the 21st login request from one address within a minute is 429', async () => {
    for (let i = 0; i < 20; i++)
      await login({
        email: `ip-${i}@example.com`,
        password: 'wrong password!',
      }).expect(401);
    const res = await login({
      email: 'ip-21@example.com',
      password: 'wrong password!',
    }).expect(429);
    expect(problemDetailsSchema.parse(res.body).code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('S01 AS-15: rotating CF-Connecting-IP, X-Forwarded-For and X-Real-IP does not escape the per-address limit', async () => {
    for (let i = 0; i < 20; i++)
      await login(
        { email: `spoof-${i}@example.com`, password: 'wrong password!' },
        {
          'CF-Connecting-IP': `203.0.113.${i + 1}`,
          'X-Forwarded-For': `198.51.100.${i + 1}`,
          'X-Real-IP': `192.0.2.${i + 1}`,
        },
      ).expect(401);
    await login(
      { email: 'spoof-21@example.com', password: 'wrong password!' },
      {
        'CF-Connecting-IP': '203.0.113.200',
        'X-Forwarded-For': '198.51.100.200',
        'X-Real-IP': '192.0.2.200',
      },
    ).expect(429);
  });

  describe('S01 AS-16: rehash on login', () => {
    const users = () => t.app.get<UserRepository>(USER_REPOSITORY);
    const stored = async (id: string) =>
      (await users().findById(id))!.passwordHash!;

    it('upgrades a bcrypt hash and keeps the user logged in', async () => {
      const user = await t.seedUser({
        email: 'bcrypt@example.com',
        passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
      });
      await login({
        email: 'bcrypt@example.com',
        password: TEST_PASSWORD,
      }).expect(200);
      const hash = await stored(user.id);
      expect(hash).toMatch(/^\$argon2id\$/);
      expect(
        argon2.needsRehash(hash, {
          memoryCost: 19_456,
          timeCost: 2,
          parallelism: 1,
        }),
      ).toBe(false);
    });

    it('upgrades an Argon2id hash with outdated parameters', async () => {
      const old = await argon2.hash(TEST_PASSWORD, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 2,
        parallelism: 1,
      });
      const user = await t.seedUser({
        email: 'old@example.com',
        passwordHash: old,
      });
      await login({ email: 'old@example.com', password: TEST_PASSWORD }).expect(
        200,
      );
      const hash = await stored(user.id);
      expect(hash).not.toBe(old);
      expect(hash).toContain('m=19456');
    });

    it('leaves the stored hash alone after a wrong password', async () => {
      const legacy = await bcrypt.hash(TEST_PASSWORD, 10);
      const user = await t.seedUser({
        email: 'wrong@example.com',
        passwordHash: legacy,
      });
      await login({
        email: 'wrong@example.com',
        password: 'wrong password!',
      }).expect(401);
      expect(await stored(user.id)).toBe(legacy);
    });

    it('replaces the hash only while it is still the one that was verified', async () => {
      const user = await t.seedUser({ email: 'cond@example.com' });
      const current = await stored(user.id);
      expect(
        await users().replacePasswordHash(user.id, 'a stale hash', 'new'),
      ).toBe(false);
      expect(await stored(user.id)).toBe(current);
      expect(
        await users().replacePasswordHash(user.id, current, 'replacement'),
      ).toBe(true);
      expect(await stored(user.id)).toBe('replacement');
    });
  });

  it('S01 AS-19: an enrolled second factor gets a challenge, no session and no cookie', async () => {
    const user = await t.seedUser({ email: 'mfa@example.com' });
    await user.update({ mfaSecretEnc: 'sealed', mfaEnabledAt: new Date() });

    const res = await login({
      email: 'mfa@example.com',
      password: TEST_PASSWORD,
    }).expect(200);

    const body = mfaChallengeSchema.parse(res.body);
    const { header, claims } = decodeJwt(body.mfaToken);
    expect(header.typ).toBe('mfa+jwt');
    expect(claims).toMatchObject({ aud: 'mfa', sub: user.id });
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await authItems()).toHaveLength(0);
  });

  it('S01 AS-20: every login creates a new session and leaves the earlier one working', async () => {
    await t.seedUser({ email: 'twice@example.com' });
    const first = authSessionSchema.parse(
      (
        await login({
          email: 'twice@example.com',
          password: TEST_PASSWORD,
        }).expect(200)
      ).body,
    );
    const second = authSessionSchema.parse(
      (
        await login(
          { email: 'twice@example.com', password: TEST_PASSWORD },
          { Authorization: `Bearer ${first.accessToken.token}` },
        ).expect(200)
      ).body,
    );

    expect(second.sessionId).not.toBe(first.sessionId);
    await t
      .http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${first.accessToken.token}`)
      .expect(200);
  });

  describe('S01 AS-21: input limits', () => {
    it('refuses a password over 128 characters without hashing', async () => {
      const verify = jest.spyOn(PasswordHasher.prototype, 'verify');
      await login({
        email: 'limits@example.com',
        password: 'p'.repeat(129),
      }).expect(400);
      expect(verify).not.toHaveBeenCalled();
    });

    it('accepts a 128-character password and a short wrong one as an ordinary 401', async () => {
      const long = 'p'.repeat(128);
      await t.seedUser({ email: 'long@example.com', password: long });
      await login({ email: 'long@example.com', password: long }).expect(200);
      await login({ email: 'long@example.com', password: 'abcde' }).expect(401);
    });

    it('refuses a body over 16 KB with 413', async () => {
      const res = await login({
        email: 'big@example.com',
        password: TEST_PASSWORD,
        padding: 'x'.repeat(16 * 1024),
      }).expect(413);
      expect(problemDetailsSchema.parse(res.body).status).toBe(413);
    });

    it.each([
      ['email missing', { password: TEST_PASSWORD }],
      ['password missing', { email: 'a@example.com' }],
      ['email not a string', { email: 7, password: TEST_PASSWORD }],
      ['password not a string', { email: 'a@example.com', password: 7 }],
      ['empty body', {}],
    ])('answers 400 validation_failed: %s', async (_name, body) => {
      const res = await login(body).expect(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'validation_failed',
      );
    });
  });
});
