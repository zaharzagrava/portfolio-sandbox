import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import {
  authSessionSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  authStore,
  AuthTestApp,
  createAuthApp,
  TEST_PASSWORD,
} from './testing/auth-app';
import { AuthProbeModule } from './testing/probe.module';
import User from './infra/models/user.model';

const DAY_MS = 86_400_000;

describe('Refresh token rotation', () => {
  let t: AuthTestApp;
  let store: ReturnType<typeof authStore>;
  let userModel: typeof User;

  const login = async (email: string) =>
    authSessionSchema.parse(
      (
        await t
          .http()
          .post('/api/auth/login')
          .send({ email, password: TEST_PASSWORD })
          .expect(200)
      ).body,
    );
  const refresh = (refreshToken?: unknown) =>
    t
      .http()
      .post('/api/auth/refresh')
      .send(refreshToken === undefined ? {} : { refreshToken });
  const seededSession = async () => {
    const user = await t.seedUser();
    return { user, session: await login(user.email!) };
  };

  beforeAll(async () => {
    t = await createAuthApp({ extraImports: [AuthProbeModule] });
    store = authStore(t.app);
    userModel = t.app.get(getModelToken(User));
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
  });

  it('S01 AS-31: rotation gives a new token for the same session, spends the old one and stores only digests', async () => {
    const { session } = await seededSession();
    t.clock.advance(60_000);

    const res = await refresh(session.refreshToken).expect(200);

    const next = authSessionSchema.parse(res.body);
    expect(next.sessionId).toBe(session.sessionId);
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect(next.accessToken.token).not.toBe(session.accessToken.token);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await store.token(session.refreshToken)).toMatchObject({
      usedAt: expect.any(String),
    });
    expect(await store.token(next.refreshToken)).toMatchObject({
      sid: session.sessionId,
    });
    expect((await store.token(next.refreshToken))?.usedAt).toBeUndefined();
    const record = await store.session(session.sessionId);
    expect(Date.parse(record!.lastUsedAt)).toBeGreaterThan(
      Date.parse(record!.createdAt),
    );
    const stored = JSON.stringify(await store.all());
    expect(stored).not.toContain(session.refreshToken);
    expect(stored).not.toContain(next.refreshToken);
  });

  it('S01 AS-32: presenting a spent token revokes that session only, with an audit line and a counter', async () => {
    const { user, session } = await seededSession();
    const other = await login(user.email!);
    const rotated = authSessionSchema.parse(
      (await refresh(session.refreshToken).expect(200)).body,
    );
    const log = jest.spyOn(Logger.prototype, 'log');
    const reuse = () => MetricsRegistry.value('auth_refresh_reuse_total') ?? 0;
    const before = reuse();

    const res = await refresh(session.refreshToken).expect(401);

    expect(problemDetailsSchema.parse(res.body).code).toBe(
      'invalid_refresh_token',
    );
    await refresh(rotated.refreshToken).expect(401); // the family is dead too
    await t
      .http()
      .post('/api/probe/sensitive')
      .set({ Authorization: `Bearer ${rotated.accessToken.token}` })
      .expect(401);
    expect(await store.session(session.sessionId)).toMatchObject({
      revokeReason: 'refresh_token_reuse',
      revokedAt: expect.any(String),
    });
    await refresh(other.refreshToken).expect(200); // the user's other session is untouched
    const audits = log.mock.calls.filter(
      ([message]) =>
        (message as { event?: string })?.event ===
        'auth.refresh.reuse_detected',
    );
    expect(audits).toHaveLength(1);
    expect(reuse()).toBe(before + 1);
  });

  it('S01 AS-33: two simultaneous refreshes of one token yield one success, one stored successor, then a revoked session', async () => {
    const { session } = await seededSession();

    const [a, b] = await Promise.all([
      refresh(session.refreshToken),
      refresh(session.refreshToken),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const winner = authSessionSchema.parse((a.status === 200 ? a : b).body);
    const items = (await store.all()).filter(
      (i) => i.PK.startsWith('RT#') && i.sid === session.sessionId,
    );
    expect(items).toHaveLength(2); // the original and exactly one successor
    await refresh(winner.refreshToken).expect(401);
    expect(await store.session(session.sessionId)).toMatchObject({
      revokeReason: 'refresh_token_reuse',
    });
  });

  describe('S01 AS-34: unusable values', () => {
    it('answers every unknown, garbage or foreign token identically and changes nothing', async () => {
      const { user, session } = await seededSession();
      const second = await login(user.email!);
      await t
        .http()
        .post('/api/auth/logout')
        .set({ Authorization: `Bearer ${second.accessToken.token}` })
        .expect(204);
      const before = JSON.stringify(await store.all());

      const bodies: ReturnType<typeof problemDetailsSchema.parse>[] = [];
      for (const value of [undefined, 'x'.repeat(43), second.refreshToken]) {
        const res = await refresh(value).expect(401);
        bodies.push(problemDetailsSchema.parse(res.body));
      }
      const strip = ({
        requestId: _r,
        instance: _i,
        ...rest
      }: Record<string, unknown>) => rest;
      expect(bodies.map(strip)).toEqual([
        strip(bodies[0]),
        strip(bodies[0]),
        strip(bodies[0]),
      ]);
      expect(bodies[0].code).toBe('invalid_refresh_token');
      expect(JSON.stringify(await store.all())).toBe(before);
      void session;
    });

    it('refuses a value over 256 characters with validation_failed', async () => {
      const res = await refresh('r'.repeat(257)).expect(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'validation_failed',
      );
    });
  });

  it('S01 AS-35: idle expiry at 30 days is exact and an expired token does not mark the session compromised', async () => {
    const { session } = await seededSession();
    t.clock.advance(30 * DAY_MS - 1000);
    await refresh(session.refreshToken).expect(200);

    const late = await seededSession();
    const log = jest.spyOn(Logger.prototype, 'log');
    t.clock.advance(30 * DAY_MS + 1000);
    await refresh(late.session.refreshToken).expect(401);

    expect(
      (await store.session(late.session.sessionId))?.revokedAt,
    ).toBeUndefined();
    expect(
      log.mock.calls.filter(
        ([m]) =>
          (m as { event?: string })?.event === 'auth.refresh.reuse_detected',
      ),
    ).toHaveLength(0);
  });

  it('S01 AS-36: the absolute 90-day cap beats the idle window', async () => {
    const { session } = await seededSession();
    const absolute = (await store.session(session.sessionId))!
      .absoluteExpiry as number;
    let token = session.refreshToken;
    for (const day of [29, 58, 87]) {
      t.clock.set(
        new Date(
          Date.parse((await store.session(session.sessionId))!.createdAt) +
            day * DAY_MS,
        ),
      );
      token = authSessionSchema.parse(
        (await refresh(token).expect(200)).body,
      ).refreshToken;
    }
    t.clock.set(
      new Date(
        Date.parse((await store.session(session.sessionId))!.createdAt) +
          89 * DAY_MS,
      ),
    );
    token = authSessionSchema.parse(
      (await refresh(token).expect(200)).body,
    ).refreshToken;
    expect((await store.token(token))?.expiresAtEpoch).toBe(absolute); // capped at day 90, not day 119

    t.clock.set(
      new Date(
        Date.parse((await store.session(session.sessionId))!.createdAt) +
          90 * DAY_MS +
          1000,
      ),
    );
    await refresh(token).expect(401);
  });

  describe('S01 AS-37: the account or session is gone', () => {
    it('after logout-all the older refresh tokens are dead', async () => {
      const { user, session } = await seededSession();
      const second = await login(user.email!);
      await t
        .http()
        .post('/api/auth/logout-all')
        .set({ Authorization: `Bearer ${second.accessToken.token}` })
        .expect(200);
      await refresh(session.refreshToken).expect(401);
      await refresh(second.refreshToken).expect(401);
    });

    it('for a soft-deleted user the exchange fails and the session is revoked', async () => {
      const { user, session } = await seededSession();
      await userModel.destroy({ where: { id: user.id } });

      await refresh(session.refreshToken).expect(401);

      expect(await store.session(session.sessionId)).toMatchObject({
        revokeReason: 'user_deleted',
      });
    });
  });

  it('S01 AS-38: the 61st refresh request of a minute is 429 and leaves the presented token unspent', async () => {
    const { session } = await seededSession();
    for (let i = 0; i < 60; i++) await refresh('x'.repeat(43)).expect(401);

    const res = await refresh(session.refreshToken).expect(429);

    expect(problemDetailsSchema.parse(res.body).code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await store.token(session.refreshToken))?.usedAt).toBeUndefined();
  });
});
