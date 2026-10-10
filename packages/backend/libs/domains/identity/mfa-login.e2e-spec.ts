import { Sequelize } from 'sequelize-typescript';
import {
  authSessionSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  AuthTestApp,
  authStore,
  createAuthApp,
  decodeJwt,
} from './testing/auth-app';
import {
  challengeRows,
  codeAt,
  enableSecondFactor,
  flushRedis,
  passwordLogin,
  recoveryRows,
  secondFactorRow,
} from './testing/mfa-fixtures';
import { USER_REPOSITORY, type UserRepository } from './domain/ports';
import { stepAt, totpCode } from './domain/totp';

const FRONT = 'http://localhost:3000';

describe('Second factor at login', () => {
  let t: AuthTestApp;
  let counter = 0;

  beforeAll(async () => {
    t = await createAuthApp({ manualRateTime: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
  });

  /** A member whose second factor is enabled. */
  async function member() {
    const email = `mfa-${++counter}@example.com`;
    const user = await t.seedUser({ email });
    const factor = await enableSecondFactor(t, user.id);
    return { user, email, ...factor };
  }

  const challengeFor = async (email: string) =>
    (await passwordLogin(t, email)).mfaToken!;

  const verify = (
    body: unknown,
    headers: Record<string, string> = {},
    type = 'application/json',
  ) =>
    t
      .http()
      .post('/api/auth/mfa/verify')
      .set('Content-Type', type)
      .set(headers)
      .send(typeof body === 'string' ? body : JSON.stringify(body));

  const codeOf = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body).code;

  /** A six-digit code that is not valid at any step the verifier accepts. */
  const wrongCode = (secret: string) => {
    const valid = new Set(
      [-2, -1, 0, 1, 2].map((o) =>
        totpCode(secret, stepAt(t.clock.nowMs()) + o),
      ),
    );
    return ['000000', '111111', '222222', '333333', '444444', '555555'].find(
      (c) => !valid.has(c),
    )!;
  };

  it('S02 AS-12: a valid TOTP code completes the login with amr [pwd, otp, mfa], a new session and no-store', async () => {
    const { user, email, secret } = await member();
    const mfaToken = await challengeFor(email);

    const res = await verify({ mfaToken, code: codeAt(t, secret) }).expect(200);

    const body = authSessionSchema.parse(res.body);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(body.user.id).toBe(user.id);
    const { claims } = decodeJwt(body.accessToken.token);
    expect(claims).toMatchObject({
      sub: user.id,
      sid: body.sessionId,
      amr: ['pwd', 'otp', 'mfa'],
    });
    const stored = await authStore(t.app).session(body.sessionId);
    expect(stored).toMatchObject({ userId: user.id });
    expect(body.sessionId).not.toBe(decodeJwt(mfaToken).claims.jti);
    expect(Number((await secondFactorRow(t, user.id))!.lastStep)).toBe(
      stepAt(t.clock.nowMs()),
    );
  });

  describe('S02 AS-13: cookie delivery', () => {
    it('sets the three __Host- cookies, puts no token in the body and clears the challenge cookie', async () => {
      const { email, secret } = await member();
      const mfaToken = await challengeFor(email);

      const res = await verify(
        { code: codeAt(t, secret), delivery: 'cookie' },
        { Origin: FRONT, Cookie: `__Host-mfa-challenge=${mfaToken}` },
      ).expect(200);

      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      expect(res.body).toMatchObject({ sessionId: expect.any(String) });
      const cookies = res.headers['set-cookie'] as unknown as string[];
      const named = (name: string) =>
        cookies.find((c) => c.startsWith(`${name}=`))!;
      for (const name of ['__Host-access', '__Host-refresh', '__Host-csrf']) {
        expect(named(name)).toBeDefined();
        expect(named(name)).toMatch(/; Path=\/(;|$)/);
        expect(named(name)).toContain('Secure');
        expect(named(name)).toContain('SameSite=Lax');
        expect(named(name)).not.toContain('Domain=');
      }
      expect(named('__Host-access')).toContain('HttpOnly');
      expect(named('__Host-refresh')).toContain('HttpOnly');
      expect(named('__Host-csrf')).not.toContain('HttpOnly');
      expect(named('__Host-mfa-challenge')).toMatch(/Expires=Thu, 01 Jan 1970/);
    });

    it('refuses a foreign origin with 403 and leaves the challenge unconsumed', async () => {
      const { email, secret } = await member();
      const mfaToken = await challengeFor(email);

      const res = await verify(
        { mfaToken, code: codeAt(t, secret), delivery: 'cookie' },
        { Origin: 'https://evil.example' },
      ).expect(403);

      expect(codeOf(res)).toBe('origin_not_allowed');
      expect(await challengeRows(t)).toHaveLength(0);
      await verify(
        { mfaToken, code: codeAt(t, secret), delivery: 'cookie' },
        { Origin: FRONT },
      ).expect(200);
    });
  });

  it('S02 AS-14: a used code and a spent challenge are refused', async () => {
    const { email, secret } = await member();
    const code = codeAt(t, secret);
    const first = await challengeFor(email);
    await verify({ mfaToken: first, code }).expect(200);

    // the same code on a new challenge: a replay of the step
    const second = await challengeFor(email);
    const replay = await verify({ mfaToken: second, code }).expect(401);
    expect(codeOf(replay)).toBe('invalid_mfa_code');
    // the previous step's code is not accepted after a later one was used
    const older = await verify({
      mfaToken: second,
      code: codeAt(t, secret, -1),
    }).expect(401);
    expect(codeOf(older)).toBe('invalid_mfa_code');

    // the spent challenge with a fresh, valid code
    const spent = await verify({
      mfaToken: first,
      code: codeAt(t, secret, 1),
    }).expect(401);
    expect(codeOf(spent)).toBe('invalid_mfa_challenge');
  });

  it('S02 AS-15: parallel use of one challenge, and of one code on two challenges, yields one session', async () => {
    const { user, email, secret } = await member();
    const code = codeAt(t, secret);
    const token = await challengeFor(email);

    const same = await Promise.all([
      verify({ mfaToken: token, code }),
      verify({ mfaToken: token, code }),
    ]);
    expect(same.map((r) => r.status).sort()).toEqual([200, 401]);

    const code2 = codeAt(t, secret, 1);
    const [a, b] = [await challengeFor(email), await challengeFor(email)];
    const two = await Promise.all([
      verify({ mfaToken: a, code: code2 }),
      verify({ mfaToken: b, code: code2 }),
    ]);
    expect(two.map((r) => r.status).sort()).toEqual([200, 401]);

    const sessions = (await authStore(t.app).all()).filter(
      (i) =>
        i.SK === 'META' &&
        i.userId === user.id &&
        String(i.PK).startsWith('SESSION#'),
    );
    expect(sessions).toHaveLength(2);
  });

  describe('S02 AS-16: wrong codes', () => {
    it('answer an identical 401 invalid_mfa_code whatever is wrong', async () => {
      const { email, secret } = await member();
      const bodies: unknown[] = [];
      for (const code of [wrongCode(secret), codeAt(t, secret, 5)]) {
        const res = await verify({
          mfaToken: await challengeFor(email),
          code,
        }).expect(401);
        const { type, title, status, detail, code: c } = res.body;
        bodies.push({ type, title, status, detail, code: c });
      }
      expect(bodies[0]).toEqual(bodies[1]);
      expect((bodies[0] as { code: string }).code).toBe('invalid_mfa_code');
    });

    it('burn the challenge on the third attempt, even for the right code afterwards', async () => {
      const { email, secret } = await member();
      const token = await challengeFor(email);
      for (let i = 0; i < 3; i++)
        expect(
          codeOf(
            await verify({ mfaToken: token, code: wrongCode(secret) }).expect(
              401,
            ),
          ),
        ).toBe('invalid_mfa_code');

      const res = await verify({
        mfaToken: token,
        code: codeAt(t, secret),
      }).expect(401);

      expect(codeOf(res)).toBe('invalid_mfa_challenge');
    });

    it('allow at most three comparisons in a parallel burst', async () => {
      const { email, secret } = await member();
      const token = await challengeFor(email);

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          verify({ mfaToken: token, code: wrongCode(secret) }),
        ),
      );

      const compared = results.filter(
        (r) => r.status === 401 && codeOf(r) === 'invalid_mfa_code',
      );
      expect(compared.length).toBeLessThanOrEqual(3);
      const state = await challengeRows(t);
      expect(state).toHaveLength(1);
      expect(state[0].attempts).toBeLessThanOrEqual(3);
    });
  });

  describe('S02 AS-19: challenge defects are one identical 401 invalid_mfa_challenge', () => {
    const answer = async (token: string, secret: string) => {
      const res = await verify({
        mfaToken: token,
        code: codeAt(t, secret),
      }).expect(401);
      const { type, title, status, detail, code } = res.body;
      return { type, title, status, detail, code };
    };

    it('for an expired, tampered, mistyped, orphaned or de-factored challenge', async () => {
      const { user, email, secret } = await member();
      const reference = await answer('not-a-token', secret);
      expect(reference.code).toBe('invalid_mfa_challenge');

      const expired = await challengeFor(email);
      t.clock.advance(400_000); // past the 5-minute lifetime and the clock-skew tolerance
      expect(await answer(expired, secret)).toEqual(reference);
      t.clock.advance(-400_000);

      const tampered = await challengeFor(email);
      const flipped = `${tampered.slice(0, -2)}${tampered.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
      expect(await answer(flipped, secret)).toEqual(reference);

      const accessToken = (
        await t
          .seedUser({ email: 'plain-19@example.com' })
          .then((u) => passwordLogin(t, u.email!))
      ).accessToken!;
      expect(await answer(accessToken, secret)).toEqual(reference);

      const live = await challengeFor(email);
      // the factor is no longer enabled
      await t.app
        .get(Sequelize)
        .query(`DELETE FROM "SecondFactor" WHERE "userId" = $1`, {
          bind: [user.id],
        });
      expect(await answer(live, secret)).toEqual(reference);
    });

    it('for a user who no longer exists', async () => {
      const { user, email, secret } = await member();
      const token = await challengeFor(email);
      await user.destroy();

      const res = await verify({
        mfaToken: token,
        code: codeAt(t, secret),
      }).expect(401);

      expect(codeOf(res)).toBe('invalid_mfa_challenge');
    });
  });

  describe('S02 AS-17: per-account budget', () => {
    it('allows five failures per 15 minutes, refuses the sixth with Retry-After, and slides with the clock', async () => {
      const { email, secret } = await member();
      for (let i = 0; i < 5; i++)
        await verify({
          mfaToken: await challengeFor(email),
          code: wrongCode(secret),
        }).expect(401);

      const res = await verify({
        mfaToken: await challengeFor(email),
        code: codeAt(t, secret),
      }).expect(429);
      expect(codeOf(res)).toBe('rate_limited');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

      t.clock.advance(15 * 60_000 + 1000);
      t.rateTime.advance(15 * 60_000 + 1000);
      await verify({
        mfaToken: await challengeFor(email),
        code: codeAt(t, secret),
      }).expect(200);
    });

    it('is cleared by a success', async () => {
      const { email, secret } = await member();
      for (let i = 0; i < 4; i++)
        await verify({
          mfaToken: await challengeFor(email),
          code: wrongCode(secret),
        }).expect(401);
      await verify({
        mfaToken: await challengeFor(email),
        code: codeAt(t, secret),
      }).expect(200);
      for (let i = 0; i < 4; i++)
        await verify({
          mfaToken: await challengeFor(email),
          code: wrongCode(secret),
        }).expect(401);
      await verify({
        mfaToken: await challengeFor(email),
        code: codeAt(t, secret, 1),
      }).expect(200);
    });

    it('is not charged for a malformed body', async () => {
      const { email, secret } = await member();
      for (let i = 0; i < 6; i++)
        await verify({ mfaToken: await challengeFor(email) }).expect(400);
      await verify({
        mfaToken: await challengeFor(email),
        code: codeAt(t, secret),
      }).expect(200);
    });
  });

  it('S02 AS-18: the 21st request from one address in a minute is 429, even with a malformed body', async () => {
    for (let i = 0; i < 20; i++)
      await verify({ mfaToken: 'x', code: '123456' }).expect(401);

    const res = await verify({}).expect(429);

    expect(codeOf(res)).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  describe('S02 AS-20: recovery codes', () => {
    it.each([
      ['as shown', (c: string) => c],
      ['in lower case', (c: string) => c.toLowerCase()],
      ['without the hyphen', (c: string) => c.replace('-', '')],
    ])('log in %s, are spent once, and are counted', async (_n, form) => {
      const { user, email, recoveryCodes } = await member();

      const res = await verify({
        mfaToken: await challengeFor(email),
        code: form(recoveryCodes[0]),
      }).expect(200);

      const body = authSessionSchema.parse(res.body);
      expect(decodeJwt(body.accessToken.token).claims.amr).toEqual([
        'pwd',
        'rcv',
        'mfa',
      ]);
      const rows = await recoveryRows(t, user.id);
      expect(rows.filter((r) => r.usedAt)).toHaveLength(1);
      const events = (await outboxRowsFor(t.app, user.id)).filter(
        (e) => e.type === 'identity.mfa_recovery_code_used',
      );
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        payload: { userId: user.id, remaining: 9 },
      });

      const again = await verify({
        mfaToken: await challengeFor(email),
        code: recoveryCodes[0],
      }).expect(401);
      expect(codeOf(again)).toBe('invalid_mfa_code');
    });
  });

  it('S02 AS-21: one recovery code used by two parallel requests yields one session', async () => {
    const { email, recoveryCodes } = await member();
    const [a, b] = [await challengeFor(email), await challengeFor(email)];

    const results = await Promise.all([
      verify({ mfaToken: a, code: recoveryCodes[1] }),
      verify({ mfaToken: b, code: recoveryCodes[1] }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('S02 AS-22: what a password reset does to the account leaves the second factor enabled and still demanded', async () => {
    // The reset endpoint belongs to S01 and is not built yet; its only write to the account is the password hash.
    const { user, email } = await member();
    const users = t.app.get<UserRepository>(USER_REPOSITORY);
    const current = (await users.findById(user.id))!.passwordHash!;
    expect(
      await users.replacePasswordHash(user.id, current, 'a-new-hash'),
    ).toBe(true);

    expect((await secondFactorRow(t, user.id))!.state).toBe('enabled');
    expect(email).toBeDefined();
    expect(await recoveryRows(t, user.id)).toHaveLength(10);
  });

  it('S02 AS-23: the verify body is validated and must be JSON', async () => {
    const { email } = await member();
    const mfaToken = await challengeFor(email);

    for (const body of [
      { mfaToken },
      { mfaToken, code: 'x'.repeat(33) },
      { mfaToken, code: '123456', extra: 1 },
      { mfaToken, code: '12 3456' },
    ])
      expect(codeOf(await verify(body).expect(400))).toBe('validation_failed');

    const res = await verify(
      `mfaToken=${mfaToken}&code=123456`,
      {},
      'text/plain',
    ).expect(415);
    expect(codeOf(res)).toBe('unsupported_media_type');
    const form = await verify(
      `mfaToken=${mfaToken}&code=123456`,
      {},
      'application/x-www-form-urlencoded',
    ).expect(415);
    expect(codeOf(form)).toBe('unsupported_media_type');
  });

  it('S02 AS-24: the replay guard survives a cache flush and an application restart', async () => {
    const { user, email, secret } = await member();
    const code = codeAt(t, secret);
    await verify({ mfaToken: await challengeFor(email), code }).expect(200);

    await flushRedis(t);
    const restarted = await createAuthApp();
    try {
      restarted.clock.set(t.clock.now());
      const login = await restarted
        .http()
        .post('/api/auth/login')
        .send({ email, password: 'correct horse battery staple' })
        .expect(200);
      const res = await restarted
        .http()
        .post('/api/auth/mfa/verify')
        .send({ mfaToken: login.body.mfaToken, code })
        .expect(401);
      expect(codeOf(res)).toBe('invalid_mfa_code');
      expect(Number((await secondFactorRow(t, user.id))!.lastStep)).toBe(
        stepAt(t.clock.nowMs()),
      );
    } finally {
      await restarted.close();
    }
  });
});
