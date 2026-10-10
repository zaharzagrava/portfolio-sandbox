import { createHash } from 'node:crypto';
import { Sequelize } from 'sequelize-typescript';
import {
  mfaEnrollSchema,
  mfaRecoveryCodesSchema,
  mfaStatusSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import {
  challengeRows,
  codeAt,
  enableSecondFactor,
  flushRedis,
  passwordLogin,
  recoveryRows,
  secondFactorRow,
} from './testing/mfa-fixtures';
import { SecretBox } from './infra/crypto/secret-box';
import { MfaMaintenanceService } from './application/mfa-maintenance.service';
import { totpCode, stepAt } from './domain/totp';

describe('Second factor enrolment', () => {
  let t: AuthTestApp;
  let counter = 0;

  beforeAll(async () => {
    t = await createAuthApp();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** A member with a password who is signed in. */
  async function member() {
    const email = `member-${++counter}@example.com`;
    const user = await t.seedUser({ email });
    const { accessToken } = await passwordLogin(t, email);
    return { user, email, token: accessToken! };
  }

  const enroll = (token?: string) =>
    t
      .http()
      .post('/api/auth/mfa/enroll')
      .set(token ? bearer(token) : {});
  const confirm = (token: string | undefined, body: unknown) =>
    t
      .http()
      .post('/api/auth/mfa/confirm')
      .set(token ? bearer(token) : {})
      .send(body as object);
  const status = (token?: string) =>
    t
      .http()
      .get('/api/auth/mfa')
      .set(token ? bearer(token) : {});

  /** Enrols and returns the manual key the authenticator would hold. */
  async function enrolled(token: string) {
    const res = await enroll(token).expect(200);
    return mfaEnrollSchema.parse(res.body);
  }

  it('S02 AS-01: enrolling from none returns the URI, stores a pending secret bound to the user and leaves login unchanged', async () => {
    const { user, email, token } = await member();
    const other = await t.seedUser({ email: 'other-01@example.com' });

    const res = await enroll(token).expect(200);

    const body = mfaEnrollSchema.parse(res.body);
    expect(body.otpauthUri).toContain(
      `otpauth://totp/Marketplace%3A${encodeURIComponent(email)}`,
    );
    expect(body.otpauthUri).toContain(`secret=${body.manualEntryKey}`);
    expect(res.headers['cache-control']).toBe('no-store');

    const row = await secondFactorRow(t, user.id);
    expect(row).toMatchObject({ state: 'pending', sealVersion: 1 });
    expect(row!.pendingExpiresAt!.getTime()).toBe(
      t.clock.nowMs() + 15 * 60_000,
    );
    expect(row!.enabledAt).toBeNull();
    const box = t.app.get(SecretBox);
    expect(box.open(row!.secretSealed, `mfa:${user.id}`)).toBe(
      body.manualEntryKey,
    );
    expect(() => box.open(row!.secretSealed, `mfa:${other.id}`)).toThrow();
    expect(row!.secretSealed).not.toContain(body.manualEntryKey);

    const login = await passwordLogin(t, email);
    expect(login.mfaToken).toBeUndefined();
    expect(login.accessToken).toEqual(expect.any(String));
  });

  it('S02 AS-02: enrolling again while pending replaces the secret and the expiry', async () => {
    const { user, token } = await member();
    const first = await enrolled(token);
    t.clock.advance(5 * 60_000);

    const second = await enrolled(token);

    expect(second.manualEntryKey).not.toBe(first.manualEntryKey);
    const row = await secondFactorRow(t, user.id);
    expect(row!.pendingExpiresAt!.getTime()).toBe(
      t.clock.nowMs() + 15 * 60_000,
    );
    expect(t.app.get(SecretBox).open(row!.secretSealed, `mfa:${user.id}`)).toBe(
      second.manualEntryKey,
    );
  });

  it('S02 AS-03: enrolling while enabled is 409 mfa_already_enabled and changes nothing', async () => {
    const { user, token } = await member();
    await enableSecondFactor(t, user.id);
    const before = await secondFactorRow(t, user.id);

    const res = await enroll(token).expect(409);

    expect(problemDetailsSchema.parse(res.body).code).toBe(
      'mfa_already_enabled',
    );
    expect(await secondFactorRow(t, user.id)).toEqual(before);
  });

  it('S02 AS-04: a valid code enables the factor, returns ten recovery codes stored as keyed digests and records the step and the event', async () => {
    const { user, email, token } = await member();
    const { manualEntryKey } = await enrolled(token);

    const res = await confirm(token, {
      code: codeAt(t, manualEntryKey),
    }).expect(200);

    const { recoveryCodes } = mfaRecoveryCodesSchema.parse(res.body);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(res.headers['cache-control']).toBe('no-store');

    const row = await secondFactorRow(t, user.id);
    expect(row).toMatchObject({ state: 'enabled' });
    expect(row!.pendingExpiresAt).toBeNull();
    expect(row!.enabledAt!.getTime()).toBe(t.clock.nowMs());
    expect(Number(row!.lastStep)).toBe(stepAt(t.clock.nowMs()));

    const stored = await recoveryRows(t, user.id);
    expect(stored).toHaveLength(10);
    for (const code of recoveryCodes) {
      const plain = code.replace('-', '');
      for (const candidate of [code, plain])
        expect(stored.map((r) => r.digest)).not.toContain(candidate);
      expect(stored.map((r) => r.digest)).not.toContain(
        createHash('sha256').update(plain).digest('hex'),
      );
      expect(stored.map((r) => r.digest)).not.toContain(
        createHash('sha256').update(plain).digest('base64url'),
      );
      expect(stored.map((r) => r.digest)).toContain(
        t.app.get(SecretBox).keyedDigest('mfa-recovery', plain),
      );
    }

    const events = (await outboxRowsFor(t.app, user.id)).filter(
      (e) => e.type === 'identity.mfa_enabled',
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      type: 'identity.mfa_enabled',
      payload: { userId: user.id },
    });

    // The next password login now asks for the second factor.
    const login = await passwordLogin(t, email);
    expect(login.mfaToken).toEqual(expect.any(String));
    expect(login.accessToken).toBeUndefined();
  });

  it('S02 AS-06: confirming in none, in an expired pending enrolment and in enabled is 409 mfa_not_pending and changes nothing', async () => {
    const { user, email, token } = await member();

    // none
    let res = await confirm(token, { code: '123456' }).expect(409);
    expect(problemDetailsSchema.parse(res.body).code).toBe('mfa_not_pending');
    expect(await secondFactorRow(t, user.id)).toBeUndefined();

    // expired pending
    const { manualEntryKey } = await enrolled(token);
    t.clock.advance(15 * 60_000 + 1000);
    const fresh = (await passwordLogin(t, email)).accessToken!;
    res = await confirm(fresh, {
      code: codeAt(t, manualEntryKey),
    }).expect(409);
    expect(problemDetailsSchema.parse(res.body).code).toBe('mfa_not_pending');
    expect((await secondFactorRow(t, user.id))!.state).toBe('pending');
    expect(await recoveryRows(t, user.id)).toHaveLength(0);

    // enabled
    await t.reset();
    await flushRedis(t);
    const second = await member();
    const { secret } = await enableSecondFactor(t, second.user.id);
    const before = await secondFactorRow(t, second.user.id);
    res = await confirm(second.token, { code: codeAt(t, secret, 1) }).expect(
      409,
    );
    expect(problemDetailsSchema.parse(res.body).code).toBe('mfa_not_pending');
    expect(await secondFactorRow(t, second.user.id)).toEqual(before);
  });

  it('S02 AS-05: malformed codes are 400, a wrong code is 422 invalid_code and is counted against the account', async () => {
    const { user, token } = await member();
    const { manualEntryKey } = await enrolled(token);

    for (const body of [
      {},
      { code: '' },
      { code: '12345' },
      { code: '1234567' },
      { code: 'abcdef' },
      { code: ' 12345' },
      { code: 123456 },
      { code: '123456', extra: true },
    ]) {
      const res = await confirm(token, body).expect(400);
      const problem = problemDetailsSchema.parse(res.body);
      expect(problem.code).toBe('validation_failed');
      expect(problem.requestId).toEqual(expect.any(String));
    }
    // Malformed bodies cost nothing: five wrong codes are still all answered 422.
    const valid = new Set(
      [-1, 0, 1].map((o) =>
        totpCode(manualEntryKey, stepAt(t.clock.nowMs()) + o),
      ),
    );
    const wrong = [
      '000000',
      '111111',
      '222222',
      '333333',
      '444444',
      '555555',
      '666666',
      '777777',
    ]
      .filter((c) => !valid.has(c))
      .slice(0, 5);
    expect(wrong).toHaveLength(5);
    for (const code of wrong) {
      const res = await confirm(token, { code }).expect(422);
      const problem = problemDetailsSchema.parse(res.body);
      expect(problem.code).toBe('invalid_code');
      expect(problem.requestId).toEqual(expect.any(String));
    }
    expect((await secondFactorRow(t, user.id))!.state).toBe('pending');

    // Out of attempts: even the right code is refused now.
    const res = await confirm(token, {
      code: codeAt(t, manualEntryKey),
    }).expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await secondFactorRow(t, user.id))!.state).toBe('pending');
  });

  it('S02 AS-07: two confirmations with the same valid code produce one winner, one code set and one event', async () => {
    const { user, token } = await member();
    const { manualEntryKey } = await enrolled(token);
    const code = codeAt(t, manualEntryKey);

    const [a, b] = await Promise.all([
      confirm(token, { code }),
      confirm(token, { code }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(problemDetailsSchema.parse(loser.body).code).toBe('mfa_not_pending');
    expect(await recoveryRows(t, user.id)).toHaveLength(10);
    expect(
      (await outboxRowsFor(t.app, user.id)).filter(
        (e) => e.type === 'identity.mfa_enabled',
      ),
    ).toHaveLength(1);
  });

  describe('S02 AS-08: authentication on the management endpoints', () => {
    const calls = (token?: string) => [
      status(token),
      enroll(token),
      confirm(token, { code: '123456' }),
    ];

    it('is 401 without a token', async () => {
      for (const call of calls()) await call.expect(401);
    });

    it('is 401 for a challenge token used as a bearer token', async () => {
      const { user } = await member();
      await enableSecondFactor(t, user.id);
      const { mfaToken } = await passwordLogin(t, user.email!);
      expect(mfaToken).toEqual(expect.any(String));
      for (const call of calls(mfaToken)) await call.expect(401);
    });

    it('is 401 for a revoked session', async () => {
      const { token } = await member();
      await t.http().post('/api/auth/logout').set(bearer(token)).expect(204);
      for (const call of calls(token)) await call.expect(401);
    });

    it("never touches another user's factor", async () => {
      const a = await member();
      const b = await member();
      const { manualEntryKey } = await enrolled(a.token);
      await enrolled(b.token);
      const before = await secondFactorRow(t, a.user.id);

      const res = await confirm(b.token, {
        code: codeAt(t, manualEntryKey),
      }).expect(422);

      expect(problemDetailsSchema.parse(res.body).code).toBe('invalid_code');
      expect(await secondFactorRow(t, a.user.id)).toEqual(before);
      expect((await secondFactorRow(t, b.user.id))!.state).toBe('pending');
    });
  });

  it('S02 AS-09: the status body follows the state and never carries a secret or a digest', async () => {
    const { user, token } = await member();

    let res = await status(token).expect(200);
    expect(mfaStatusSchema.parse(res.body)).toEqual({ state: 'none' });

    await enrolled(token);
    res = await status(token).expect(200);
    expect(mfaStatusSchema.parse(res.body)).toEqual({ state: 'pending' });

    await t.reset();
    await flushRedis(t);
    const enabled = await member();
    await enableSecondFactor(t, enabled.user.id);
    res = await status(enabled.token).expect(200);
    const body = mfaStatusSchema.parse(res.body);
    expect(body).toEqual({
      state: 'enabled',
      enabledAt: expect.any(String),
      recoveryCodesRemaining: 10,
    });
    const row = await secondFactorRow(t, enabled.user.id);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(row!.secretSealed);
    for (const r of await recoveryRows(t, enabled.user.id))
      expect(text).not.toContain(r.digest);
    expect(user.id).toBeDefined();
  });

  it('S02 AS-09: a migrated user (legacy factor, no recovery rows) shows zero recovery codes remaining', async () => {
    const { user, token } = await member();
    await enableSecondFactor(t, user.id, { sealVersion: 0, codes: [] });

    const res = await status(token).expect(200);

    expect(mfaStatusSchema.parse(res.body)).toMatchObject({
      state: 'enabled',
      recoveryCodesRemaining: 0,
    });
  });

  describe('S02 maintenance jobs', () => {
    const maintenance = () => t.app.get(MfaMaintenanceService);

    it('re-seals migrated secrets with the user context in bounded batches, idempotently, and login keeps working', async () => {
      const users = [await member(), await member(), await member()];
      const secrets: string[] = [];
      for (const u of users) {
        const { secret } = await enableSecondFactor(t, u.user.id, {
          sealVersion: 0,
        });
        secrets.push(secret);
      }
      // Before: a challenge is issued and a code opens the legacy row.
      expect((await passwordLogin(t, users[0].email)).mfaToken).toBeDefined();

      expect(await maintenance().resealSecrets({ batchSize: 2 })).toBe(2);
      expect(await maintenance().resealSecrets({ batchSize: 2 })).toBe(1);
      expect(await maintenance().resealSecrets({ batchSize: 2 })).toBe(0);

      const box = t.app.get(SecretBox);
      for (const [i, u] of users.entries()) {
        const row = await secondFactorRow(t, u.user.id);
        expect(row!.sealVersion).toBe(1);
        expect(box.open(row!.secretSealed, `mfa:${u.user.id}`)).toBe(
          secrets[i],
        );
      }
      expect((await passwordLogin(t, users[0].email)).mfaToken).toBeDefined();
    });

    it('purges pending enrolments that expired more than a day ago and keeps live ones', async () => {
      const old = await member();
      const live = await member();
      await enrolled(old.token);
      t.clock.advance(2 * 86_400_000);
      const fresh = (await passwordLogin(t, live.email)).accessToken!;
      await enrolled(fresh);
      const enabled = await member();
      await enableSecondFactor(t, enabled.user.id);

      expect(await maintenance().purgeExpiredPending({ batchSize: 10 })).toBe(
        1,
      );

      expect(await secondFactorRow(t, old.user.id)).toBeUndefined();
      expect((await secondFactorRow(t, live.user.id))!.state).toBe('pending');
      expect((await secondFactorRow(t, enabled.user.id))!.state).toBe(
        'enabled',
      );
    });

    it('purges challenge state that expired more than an hour ago', async () => {
      const { user } = await member();
      await enableSecondFactor(t, user.id);
      const db = t.app.get(Sequelize);
      const now = t.clock.now();
      await db.query(
        `INSERT INTO "MfaChallengeState" ("jti","userId","attempts","expiresAt") VALUES
           (uuidv7(), $1, 1, $2), (uuidv7(), $1, 1, $3)`,
        {
          bind: [
            user.id,
            new Date(now.getTime() - 2 * 3_600_000),
            new Date(now.getTime() + 60_000),
          ],
        },
      );

      expect(await maintenance().purgeChallenges({ batchSize: 10 })).toBe(1);

      expect(await challengeRows(t)).toHaveLength(1);
    });
  });
});
