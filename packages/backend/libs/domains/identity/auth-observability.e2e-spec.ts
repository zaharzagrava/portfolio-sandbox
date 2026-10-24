import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/sequelize';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import {
  memoryMailbox,
  TransactionalMailModule,
} from '@app/domains/notifications';
import {
  authStore,
  AuthTestApp,
  createAuthApp,
  TEST_PASSWORD,
} from './testing/auth-app';
import { flushRedis } from './testing/mfa-fixtures';
import { ServiceProbeModule } from './testing/probe.module';
import { KeyRotationService } from './application/key-rotation.service';
import { ServiceTokenService } from './application/service-token.service';
import { SessionIssuer } from './application/session-issuer.service';
import { Domain_OverloadedError } from './domain/errors';
import { PASSWORD_HASHER, type PasswordHasherPort } from './domain/ports';
import { KeyStore } from './infra/keys/key-store.service';
import SigningKey from './infra/models/signing-key.model';

const FRONT = 'http://localhost:3000';
const HOUR = 3_600_000;
const NEW_PASSWORD = 'a brand new passphrase 42';

describe('Auth observability', () => {
  let t: AuthTestApp;
  let counter = 0;
  const savedProvider = process.env.EMAIL_PROVIDER;

  beforeAll(async () => {
    process.env.EMAIL_PROVIDER = 'memory';
    t = await createAuthApp({
      extraImports: [ServiceProbeModule, TransactionalMailModule],
      manualRateTime: true,
    });
  });
  afterAll(async () => {
    await t.close();
    if (savedProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = savedProvider;
  });
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
    memoryMailbox.clear();
    jest.restoreAllMocks();
  });

  /** Every log call and stdout write while `fn` runs; audit lines are the object payloads logged under "Audit". */
  async function capture<T>(fn: () => Promise<T>) {
    const all: string[] = [];
    const audit: Record<string, unknown>[] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest.spyOn(Logger.prototype, method).mockImplementation(function (
        this: Logger,
        ...args: unknown[]
      ) {
        all.push(JSON.stringify(args));
        const [first] = args;
        if (
          (this as unknown as { context?: string }).context === 'Audit' &&
          first &&
          typeof first === 'object'
        )
          audit.push(first as Record<string, unknown>);
      });
    const out = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        all.push(String(chunk));
        return true;
      });
    try {
      return { result: await fn(), all, audit };
    } finally {
      out.mockRestore();
    }
  }
  const events = (audit: Record<string, unknown>[]) =>
    audit.map((a) => a.event);
  const counted = (endpoint: string, result: string, reason: string) =>
    MetricsRegistry.value('auth_events_total', { endpoint, result, reason }) ??
    0;
  const user = async () => {
    const email = `obs-${++counter}-${Date.now()}@example.com`;
    return { email, user: await t.seedUser({ email }) };
  };
  const login = (email: string, password = TEST_PASSWORD) =>
    t.http().post('/api/auth/login').send({ email, password });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tokenFor = async (email: string) => {
    const until = Date.now() + 3_000;
    for (;;) {
      const link = memoryMailbox
        .list(email)
        .flatMap((m) => m.links)
        .find((l) => l.includes('#token='));
      if (link) return link.split('#token=')[1];
      if (Date.now() > until) throw new Error('no reset mail');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('S01 AS-82: each security event writes one structured audit line with ids and no personal data, and is counted', async () => {
    const { email, user: member } = await user();
    const known = `known-${++counter}@example.com`;
    const failedBefore = counted('login', 'failure', 'invalid_credentials');
    const { audit, all } = await capture(async () => {
      // login failure for an unknown address, then a success (session creation)
      await login('nobody@example.com', 'wrong password here').expect(401);
      const session = (await login(email).expect(200)).body;
      // reuse detection
      await t
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(200);
      await t
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
      // explicit revocation
      const second = (await login(email).expect(200)).body;
      await t
        .http()
        .post('/api/auth/logout')
        .set(bearer(second.accessToken.token))
        .expect(204);
      // duplicate registration
      for (let i = 0; i < 2; i++)
        await t
          .http()
          .post('/api/auth/register')
          .send({ email: known, password: NEW_PASSWORD })
          .expect(202);
      // reset request and completion
      await t
        .http()
        .post('/api/auth/password-reset/request')
        .send({ email })
        .expect(202);
      const token = await tokenFor(email);
      await t
        .http()
        .post('/api/auth/password-reset/confirm')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);
    });

    const names = new Set(events(audit));
    for (const expected of [
      'auth.login.failed',
      'auth.session.created',
      'auth.session.revoked',
      'auth.refresh.reuse_detected',
      'auth.registration.duplicate_attempted',
      'auth.password_reset.requested',
      'auth.password_reset.completed',
    ])
      expect(names).toContain(expected);
    const failed = audit.find((a) => a.event === 'auth.login.failed')!;
    expect(failed.subject).toMatch(/^unknown:[A-Za-z0-9_-]{16}$/);
    for (const line of audit) {
      expect(line.requestId).toEqual(expect.any(String));
      const text = JSON.stringify(line);
      for (const secret of [
        '@example.com',
        NEW_PASSWORD,
        TEST_PASSWORD,
        'argon2',
        'eyJ',
      ])
        expect(text).not.toContain(secret);
    }
    const created = audit.find((a) => a.event === 'auth.session.created')!;
    expect(created).toMatchObject({
      userId: member.id,
      sessionId: expect.any(String),
    });
    const reuse = audit.find((a) => a.event === 'auth.refresh.reuse_detected')!;
    expect(reuse).toMatchObject({ sessionId: expect.any(String) });
    expect(all.join('\n')).not.toContain(NEW_PASSWORD);
    expect(counted('login', 'failure', 'invalid_credentials')).toBe(
      failedBefore + 1,
    );
    expect(counted('session', 'success', 'created')).toBeGreaterThan(0);
    expect(counted('refresh', 'failure', 'reuse')).toBeGreaterThan(0);
    for (const labels of MetricsRegistry.labelSets('auth_events_total'))
      expect(Object.keys(labels).sort()).toEqual([
        'endpoint',
        'reason',
        'result',
      ]);
  });

  it('S01 AS-82: a signing-key rotation is audited and counted', async () => {
    const keys = t.app.get(getModelToken(SigningKey)) as typeof SigningKey;
    const rotation = t.app.get(KeyRotationService);
    const owner = await user();
    await t.app
      .get(SessionIssuer)
      .issue({ userId: owner.user.id, amr: ['pwd'] });
    await rotation.run();
    const [active] = (await keys.findAll({
      where: { status: 'ACTIVE' },
      raw: true,
    })) as SigningKey[];
    const [next] = (await keys.findAll({
      where: { status: 'NEXT' },
      raw: true,
    })) as SigningKey[];
    const ago = (ms: number) => new Date(t.clock.nowMs() - ms);
    await keys.update(
      { activatedAt: ago(8 * 24 * HOUR), createdAt: ago(9 * 24 * HOUR) },
      { where: { kid: active.kid } },
    );
    await keys.update(
      { createdAt: ago(25 * HOUR) },
      { where: { kid: next.kid } },
    );

    const { audit } = await capture(() => rotation.run());

    expect(
      audit.find((a) => a.event === 'auth.signing_key.rotated'),
    ).toMatchObject({
      retired: active.kid,
      activated: next.kid,
    });
    expect(counted('signing_key', 'success', 'rotated')).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE');
  });

  it('S01 AS-83: a register → login → refresh → logout → reset flow leaves no secret in any log line', async () => {
    const email = `flow-${++counter}@example.com`;
    const password = 'a long passphrase for the flow 7';
    const secrets: string[] = [password, NEW_PASSWORD];

    const { all } = await capture(async () => {
      await t
        .http()
        .post('/api/auth/register')
        .send({ email, password })
        .expect(202);
      const session = (await login(email, password).expect(200)).body;
      secrets.push(session.accessToken.token, session.refreshToken);
      const next = (
        await t
          .http()
          .post('/api/auth/refresh')
          .send({ refreshToken: session.refreshToken })
          .expect(200)
      ).body;
      secrets.push(next.accessToken.token, next.refreshToken);
      await t
        .http()
        .post('/api/auth/logout')
        .set(bearer(next.accessToken.token))
        .expect(204);
      // cookie session: the CSRF token
      const cookie = await t
        .http()
        .post('/api/auth/login')
        .set('Origin', FRONT)
        .send({ email, password, delivery: 'cookie' })
        .expect(200);
      for (const c of cookie.headers['set-cookie'] as unknown as string[])
        secrets.push(c.split(';')[0].split('=').slice(1).join('='));
      await t
        .http()
        .post('/api/auth/password-reset/request')
        .send({ email })
        .expect(202);
      const resetToken = await tokenFor(email);
      secrets.push(resetToken);
      await t
        .http()
        .post('/api/auth/password-reset/confirm')
        .send({ token: resetToken, password: NEW_PASSWORD })
        .expect(204);
    });

    const text = all.join('\n');
    for (const secret of secrets.filter(Boolean))
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/\$argon2id\$/);
    expect(text).not.toContain(email);
  });

  describe('S01 AS-84: the error contract', () => {
    const cases: Array<
      [
        string,
        number,
        () => Promise<{
          status: number;
          body: unknown;
          headers: Record<string, unknown>;
        }>,
      ]
    > = [
      ['validation_failed', 400, () => login('') as never],
      [
        'invalid_credentials',
        401,
        async () => {
          const { email } = await user();
          return login(email, 'definitely wrong') as never;
        },
      ],
      ['invalid_token', 401, () => t.http().get('/api/auth/me') as never],
      [
        'invalid_refresh_token',
        401,
        () =>
          t
            .http()
            .post('/api/auth/refresh')
            .send({ refreshToken: 'garbage' }) as never,
      ],
      [
        'csrf_invalid',
        403,
        async () => {
          const { email } = await user();
          const res = await t
            .http()
            .post('/api/auth/login')
            .set('Origin', FRONT)
            .send({ email, password: TEST_PASSWORD, delivery: 'cookie' });
          const jar = (res.headers['set-cookie'] as unknown as string[])
            .map((c) => c.split(';')[0])
            .join('; ');
          return t.http().post('/api/auth/logout').set('Cookie', jar) as never;
        },
      ],
      [
        'origin_not_allowed',
        403,
        async () => {
          const { email } = await user();
          return t
            .http()
            .post('/api/auth/login')
            .set('Origin', 'https://evil.example')
            .send({
              email,
              password: TEST_PASSWORD,
              delivery: 'cookie',
            }) as never;
        },
      ],
      [
        'service_caller_not_allowed',
        403,
        async () => {
          const token = await t.app
            .get(ServiceTokenService, { strict: false })
            .mint({ caller: 'projector', audience: 'core' });
          return t
            .http()
            .get('/api/probe/internal')
            .set(bearer(token)) as never;
        },
      ],
      [
        'session_not_found',
        404,
        async () => {
          const { user: u } = await user();
          const s = await t.app
            .get(SessionIssuer)
            .issue({ userId: u.id, amr: ['pwd'] });
          return t
            .http()
            .delete('/api/auth/sessions/00000000-0000-7000-8000-000000000000')
            .set(bearer(s.accessToken.token)) as never;
        },
      ],
      [
        'invalid_reset_token',
        400,
        () =>
          t
            .http()
            .post('/api/auth/password-reset/confirm')
            .send({ token: 'x'.repeat(43), password: NEW_PASSWORD }) as never,
      ],
      [
        'unsupported_media_type',
        415,
        () =>
          t
            .http()
            .post('/api/auth/login')
            .set('Content-Type', 'text/plain')
            .send('x') as never,
      ],
      [
        'weak_password',
        422,
        async () => {
          t.breach.breached.add('a breached passphrase 1');
          return t
            .http()
            .post('/api/auth/register')
            .send({
              email: `weak-${++counter}@example.com`,
              password: 'a breached passphrase 1',
            }) as never;
        },
      ],
      [
        'rate_limited',
        429,
        async () => {
          let last;
          for (let i = 0; i < 6; i++)
            last = await t
              .http()
              .post('/api/auth/password-reset/request')
              .send({ email: `rl-${i}@example.com` });
          return last as never;
        },
      ],
      [
        'overloaded',
        503,
        async () => {
          const { email } = await user();
          jest
            .spyOn(t.app.get<PasswordHasherPort>(PASSWORD_HASHER), 'verify')
            .mockRejectedValue(new Domain_OverloadedError());
          return login(email) as never;
        },
      ],
    ];

    it.each(cases)(
      '%s answers %i as problem+json with the request id',
      async (code, status, call) => {
        const res = await call();

        expect(res.status).toBe(status);
        const problem = problemDetailsSchema.parse(res.body);
        expect(problem.code).toBe(code);
        expect(problem.status).toBe(status);
        expect(problem.requestId).toBe(res.headers['x-request-id']);
        expect(problem.instance).toEqual(expect.any(String));
      },
    );
  });

  // AS-85 corrupts the ACTIVE signing key on purpose. The next file of the shard (one shared process and database) must not find it
  // before its own first data wipe: take the corrupted row away again.
  afterEach(async () => {
    const keys = t.app.get(getModelToken(SigningKey)) as typeof SigningKey;
    await keys.destroy({ where: { privateKeyEnc: 'corrupted-key-material' } });
    t.app.get(KeyStore).invalidate();
  });

  it('S01 AS-85: an unreadable signing key is a generic 500 with no stack, no key text and no session left behind', async () => {
    const { email } = await user();
    const keys = t.app.get(getModelToken(SigningKey)) as typeof SigningKey;
    await t.app
      .get(SessionIssuer)
      .issue({ userId: (await user()).user.id, amr: ['pwd'] }); // bootstrap an ACTIVE key
    await keys.update(
      { privateKeyEnc: 'corrupted-key-material' },
      { where: { status: 'ACTIVE' } },
    );
    t.app.get(KeyStore).invalidate();
    const sessionsBefore = (await authStore(t.app).all()).filter((i) =>
      String(i.PK).startsWith('SESSION#'),
    ).length;

    const { result: res, all } = await capture(() => login(email));

    expect(res.status).toBe(500);
    const problem = problemDetailsSchema.parse(res.body);
    expect(problem.detail).not.toMatch(/key|stack|SQL|corrupt|secret|v1|v2/i);
    expect(JSON.stringify(res.body)).not.toContain('corrupted-key-material');
    expect(res.body.stack).toBeUndefined();
    expect(
      (await authStore(t.app).all()).filter((i) =>
        String(i.PK).startsWith('SESSION#'),
      ).length,
    ).toBe(sessionsBefore);
    expect(all.some((line) => line.includes(problem.requestId))).toBe(true);
  });
});
