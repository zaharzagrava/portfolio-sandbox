import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  codeAt,
  enableSecondFactor,
  flushRedis,
  passwordLogin,
  recoveryRows,
  secondFactorRow,
} from './testing/mfa-fixtures';
import { authStore } from './testing/auth-app';
import {
  OidcTestApp,
  callback,
  cookieValue,
  createOidcApp,
  setCookies,
  signIn,
  startFlow,
} from './testing/oidc-fixtures';

describe('S02 observability: audit lines, counters, errors, events', () => {
  let app: OidcTestApp;
  let counter = 0;

  beforeAll(async () => {
    app = await createOidcApp();
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await app.t.reset();
    await flushRedis(app.t);
    app.reset();
    jest.restoreAllMocks();
  });

  const t = () => app.t;
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const db = () => app.t.app.get(Sequelize);
  const metric = (name: string, labels: Record<string, string> = {}) =>
    MetricsRegistry.value(name, labels) ?? 0;

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
  const named = (audit: Record<string, unknown>[], event: string) =>
    audit.filter((a) => a.event === event);

  async function member() {
    const email = `obs-mfa-${++counter}@example.com`;
    const user = await t().seedUser({ email });
    const { accessToken } = await passwordLogin(t(), email);
    return { user, email, token: accessToken! };
  }
  const post = (path: string, token: string | undefined, body: object = {}) =>
    t()
      .http()
      .post(`/api/auth/mfa/${path}`)
      .set(token ? bearer(token) : {})
      .send(body);
  const verify = (mfaToken: string, code: string) =>
    t().http().post('/api/auth/mfa/verify').send({ mfaToken, code });
  const nextStep = () => t().clock.advance(31_000);

  describe('S02 AS-59 and S02 AS-60: the second-factor flow', () => {
    it('S02 AS-59: audits and counts every step, and "S02 AS-60": no log line or body carries a secret, code or challenge', async () => {
      const before = {
        totp: metric('auth_mfa_verify_total', {
          result: 'success',
          method: 'totp',
        }),
        recovery: metric('auth_mfa_verify_total', {
          result: 'success',
          method: 'recovery',
        }),
        failed: metric('auth_mfa_verify_total', {
          result: 'failure',
          method: 'totp',
        }),
        burned: metric('auth_mfa_challenge_burned_total'),
      };
      const m = await member();
      const secrets: string[] = [];
      const bodies: string[] = [];

      const { audit, all } = await capture(async () => {
        const enrol = await post('enroll', m.token).expect(200);
        const secret = enrol.body.manualEntryKey as string;
        secrets.push(secret, enrol.body.otpauthUri);
        await post('confirm', m.token, { code: '000000' }).expect(422);
        const confirmed = await post('confirm', m.token, {
          code: codeAt(t(), secret),
        }).expect(200);
        const recovery = confirmed.body.recoveryCodes as string[];
        secrets.push(...recovery);

        // A login with a TOTP code.
        nextStep();
        let challenge = (await passwordLogin(t(), m.email)).mfaToken!;
        secrets.push(challenge);
        const ok = await verify(challenge, codeAt(t(), secret)).expect(200);
        bodies.push(JSON.stringify(ok.body));

        // Three wrong codes burn a challenge.
        challenge = (await passwordLogin(t(), m.email)).mfaToken!;
        secrets.push(challenge);
        for (let i = 0; i < 3; i++) {
          const bad = await verify(challenge, '000000').expect(401);
          bodies.push(JSON.stringify(bad.body));
        }

        // A login with a recovery code.
        challenge = (await passwordLogin(t(), m.email)).mfaToken!;
        secrets.push(challenge);
        await verify(challenge, recovery[0]).expect(200);

        nextStep();
        const regenerated = await post('recovery-codes/regenerate', m.token, {
          code: codeAt(t(), secret),
        }).expect(200);
        secrets.push(...(regenerated.body.recoveryCodes as string[]));
        nextStep();
        await post('disable', m.token, { code: codeAt(t(), secret) }).expect(
          204,
        );
        return secret;
      });

      for (const event of [
        'auth.mfa.enrolled',
        'auth.mfa.confirmed',
        'auth.mfa.failed',
        'auth.mfa.verified',
        'auth.mfa.recovery_used',
        'auth.mfa.regenerated',
        'auth.mfa.disabled',
        'auth.mfa.challenge_burned',
      ])
        expect(named(audit, event).length).toBeGreaterThan(0);
      expect(named(audit, 'auth.mfa.failed')).toHaveLength(4);
      expect(named(audit, 'auth.mfa.challenge_burned')).toHaveLength(1);
      for (const line of audit.filter((a) =>
        String(a.event).startsWith('auth.mfa.'),
      ))
        expect(line).toMatchObject({
          userId: m.user.id,
          requestId: expect.any(String),
        });

      expect(
        metric('auth_mfa_verify_total', { result: 'success', method: 'totp' }),
      ).toBe(before.totp + 1);
      expect(
        metric('auth_mfa_verify_total', {
          result: 'success',
          method: 'recovery',
        }),
      ).toBe(before.recovery + 1);
      expect(
        metric('auth_mfa_verify_total', { result: 'failure', method: 'totp' }),
      ).toBe(before.failed + 3);
      expect(metric('auth_mfa_challenge_burned_total')).toBe(before.burned + 1);

      const logged = all.join('\n') + bodies.join('\n') + JSON.stringify(audit);
      for (const secret of secrets) expect(logged).not.toContain(secret);
      // The login response legitimately names the user; logs and audit lines do not.
      expect(all.join('\n') + JSON.stringify(audit)).not.toContain(m.email);
    });
  });

  describe('S02 AS-59 and S02 AS-60: the Google flows', () => {
    it('S02 AS-59: audits start, login, link, unlink and the takeover wipe and counts them, and "S02 AS-60": leaks no state, nonce, verifier, code or client secret', async () => {
      const linkBefore = (method: string) =>
        metric('auth_account_link_total', { method });
      const before = {
        login: linkBefore('login'),
        explicit: linkBefore('explicit'),
        emailMatch: linkBefore('email_match'),
        wipe: metric('auth_account_link_wipe_total'),
      };
      const locations: string[] = [];
      const seen: string[] = [];

      const { audit, all } = await capture(async () => {
        // A first sign-in creates the account.
        const first = await signIn(app, {
          sub: 'g-obs-1',
          email: 'obs-new@example.com',
          email_verified: true,
        });
        locations.push(first.res.headers.location);
        const state = new URL(first.authorizationUrl).searchParams.get(
          'state',
        )!;
        const nonce = new URL(first.authorizationUrl).searchParams.get(
          'nonce',
        )!;
        seen.push(state, nonce, first.flowCookie!);
        const code = new URL(first.back).searchParams.get('code')!;
        seen.push(code);

        // A callback that fails: the state is unknown.
        const failed = await callback(app, first.back, first.flowCookie);
        locations.push(failed.headers.location);

        // Takeover: a password account whose address a provider verified.
        await t().seedUser({ email: 'obs-victim@example.com' });
        await passwordLogin(t(), 'obs-victim@example.com');
        await signIn(app, {
          sub: 'g-obs-2',
          email: 'obs-victim@example.com',
          email_verified: true,
        });

        // An explicit link and its removal by a member with a password.
        const mine = await member();
        const start = await t()
          .http()
          .post('/api/auth/oidc/google/link/start')
          .set(bearer(mine.token))
          .send({})
          .expect(200);
        const back = app.provider.approve(start.body.authorizationUrl, {
          sub: 'g-obs-3',
          email: 'obs-link@example.com',
          email_verified: true,
        });
        const linked = await callback(
          app,
          back,
          cookieValue(setCookies(start)['__Host-oidc-flow']),
        );
        locations.push(linked.headers.location);
        const [identity] = await db().query<{ id: string }>(
          `SELECT "id" FROM "FederatedIdentity" WHERE "userId" = $1`,
          { bind: [mine.user.id], type: QueryTypes.SELECT },
        );
        await t()
          .http()
          .delete(`/api/auth/identities/${identity.id}`)
          .set(bearer(mine.token))
          .expect(204);
        // What the provider received from us: the authorization code, the verifier and the client secret.
        for (const request of app.provider.requestsTo('/token'))
          seen.push(
            ...[
              request.params.code,
              request.params.code_verifier,
              request.params.client_secret,
            ].filter(Boolean),
          );
      });

      for (const event of [
        'auth.oidc.started',
        'auth.oidc.callback_failed',
        'auth.oidc.login',
        'auth.oidc.linked',
        'auth.oidc.unlinked',
      ])
        expect(named(audit, event).length).toBeGreaterThan(0);
      expect(named(audit, 'auth.oidc.callback_failed')[0]).toMatchObject({
        code: 'oidc_state_invalid',
      });
      for (const line of audit.filter((a) =>
        String(a.event).startsWith('auth.oidc.'),
      ))
        expect(line.requestId).toEqual(expect.any(String));

      expect(linkBefore('login')).toBe(before.login + 1);
      expect(linkBefore('email_match')).toBe(before.emailMatch + 1);
      expect(linkBefore('explicit')).toBe(before.explicit + 1);
      expect(metric('auth_account_link_wipe_total')).toBe(before.wipe + 1);

      const logged = all.join('\n') + JSON.stringify(audit);
      for (const secret of [...seen, app.provider.clientSecret])
        if (secret.length > 8) expect(logged).not.toContain(secret);
      for (const location of locations)
        for (const secret of seen.slice(0, 4))
          expect(location).not.toContain(secret);
      expect(logged).not.toContain('obs-victim@example.com');
      expect(logged).not.toContain('obs-new@example.com');
    });
  });

  describe('S02 AS-61 and AS-62: errors', () => {
    it('answers every error class with the problem document, the stable code and the request id of the response', async () => {
      const m = await member();
      const enabled = await member();
      const factor = await enableSecondFactor(t(), enabled.user.id);
      const cases: Array<[number, string, () => ReturnType<typeof post>]> = [
        [
          400,
          'validation_failed',
          () => post('confirm', m.token, { code: '' }),
        ],
        [
          401,
          'invalid_token',
          () => post('confirm', undefined, { code: '123456' }),
        ],
        [401, 'invalid_mfa_challenge', () => verify('nonsense', '123456')],
        [
          409,
          'mfa_not_pending',
          () => post('confirm', m.token, { code: '123456' }),
        ],
        [
          409,
          'mfa_not_enabled',
          () => post('disable', m.token, { code: '123456' }),
        ],
        [409, 'mfa_already_enabled', () => post('enroll', enabled.token)],
        [
          422,
          'invalid_code',
          () => post('disable', enabled.token, { code: '000000' }),
        ],
      ];
      for (const [status, code, call] of cases) {
        const res = await call().expect(status);
        const problem = problemDetailsSchema.parse(res.body);
        expect(problem.code).toBe(code);
        expect(problem.requestId).toBe(res.headers['x-request-id']);
      }
      expect(factor.secret).toBeDefined();
    });

    it('answers every callback failure with one of the closed codes', async () => {
      const closed = new Set([
        'oidc_state_invalid',
        'oidc_denied',
        'oidc_exchange_failed',
        'oidc_token_invalid',
        'oidc_provider_unavailable',
        'email_not_verified',
        'account_unavailable',
        'link_conflict',
        'identity_already_linked',
      ]);
      const unknown = await t()
        .http()
        .get('/api/auth/oidc/google/callback?state=x&code=y');
      const flow = await startFlow(app);
      const denied = await t()
        .http()
        .get(
          `/api/auth/oidc/google/callback?state=${new URL(flow.authorizationUrl).searchParams.get('state')}&error=access_denied`,
        )
        .set({ Cookie: `__Host-oidc-flow=${flow.flowCookie}` });
      const unverified = await signIn(app, {
        sub: 'g-e',
        email: 'e@example.com',
        email_verified: false,
      });
      for (const res of [unknown, denied, unverified.res]) {
        expect(res.status).toBe(302);
        expect(
          closed.has(new URL(res.headers.location).searchParams.get('error')!),
        ).toBe(true);
      }
    });

    it('S02 AS-62: an unopenable secret is a generic 500; nothing is spent and no session exists', async () => {
      const m = await member();
      const { secret } = await enableSecondFactor(t(), m.user.id);
      const other = await member();
      const stolen = await enableSecondFactor(t(), other.user.id);
      const stolenRow = (await secondFactorRow(t(), other.user.id))!;
      void stolen;
      // The sealed value of another user's record: it opens only under its own context.
      await db().query(
        `UPDATE "SecondFactor" SET "secretSealed" = $1 WHERE "userId" = $2`,
        { bind: [stolenRow.secretSealed, m.user.id] },
      );
      const challenge = (await passwordLogin(t(), m.email)).mfaToken!;
      const sessionsBefore = (await authStore(t().app).all()).filter((i) =>
        String(i.PK).startsWith('SESSION#'),
      ).length;
      const codesBefore = await recoveryRows(t(), m.user.id);

      const { result: res, all } = await capture(() =>
        verify(challenge, codeAt(t(), secret)),
      );

      expect(res.status).toBe(500);
      const problem = problemDetailsSchema.parse(res.body);
      expect(problem.requestId).toBe(res.headers['x-request-id']);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|sql|key|secret/i);
      expect(
        await db().query(`SELECT * FROM "MfaChallengeState"`, {
          type: QueryTypes.SELECT,
        }),
      ).toHaveLength(0);
      expect((await secondFactorRow(t(), m.user.id))!.lastStep).toBeNull();
      expect(await recoveryRows(t(), m.user.id)).toEqual(codesBefore);
      expect(
        (await authStore(t().app).all()).filter((i) =>
          String(i.PK).startsWith('SESSION#'),
        ).length,
      ).toBe(sessionsBefore);
      expect(all.join('\n')).toContain(problem.requestId);
    });
  });

  describe('S02 AS-64: events', () => {
    const eventsOf = async (userId: string, type: string) =>
      (await outboxRowsFor(t().app, userId)).filter((e) => e.type === type);

    it('writes each of the six events with the envelope and identifiers only, and none for a rejected operation', async () => {
      const m = await member();
      const secret = (await post('enroll', m.token).expect(200)).body
        .manualEntryKey as string;
      await post('confirm', m.token, { code: '000000' }).expect(422);
      expect(await eventsOf(m.user.id, 'identity.mfa_enabled')).toHaveLength(0);
      const recovery = (
        await post('confirm', m.token, { code: codeAt(t(), secret) }).expect(
          200,
        )
      ).body.recoveryCodes as string[];

      nextStep();
      const challenge = (await passwordLogin(t(), m.email)).mfaToken!;
      await verify(challenge, recovery[0]).expect(200);
      nextStep();
      await post('recovery-codes/regenerate', m.token, {
        code: codeAt(t(), secret),
      }).expect(200);
      await post('recovery-codes/regenerate', m.token, {
        code: '000000',
      }).expect(422);
      nextStep();
      await post('disable', m.token, { code: codeAt(t(), secret) }).expect(204);
      await post('disable', m.token, { code: codeAt(t(), secret) }).expect(409);

      const start = await t()
        .http()
        .post('/api/auth/oidc/google/link/start')
        .set(bearer(m.token))
        .send({})
        .expect(200);
      const back = app.provider.approve(start.body.authorizationUrl, {
        sub: 'g-ev-1',
        email: 'ev@example.com',
        email_verified: true,
      });
      await callback(
        app,
        back,
        cookieValue(setCookies(start)['__Host-oidc-flow']),
      );
      const [identity] = await db().query<{ id: string }>(
        `SELECT "id" FROM "FederatedIdentity" WHERE "userId" = $1`,
        { bind: [m.user.id], type: QueryTypes.SELECT },
      );
      await t()
        .http()
        .delete(`/api/auth/identities/${identity.id}`)
        .set(bearer(m.token))
        .expect(204);

      const expected: Record<string, object> = {
        'identity.mfa_enabled': { userId: m.user.id },
        'identity.mfa_recovery_code_used': { userId: m.user.id, remaining: 9 },
        'identity.mfa_recovery_codes_regenerated': { userId: m.user.id },
        'identity.mfa_disabled': { userId: m.user.id, reason: 'user' },
        'identity.federated_identity_linked': {
          userId: m.user.id,
          provider: 'google',
          linkMethod: 'explicit',
          passwordInvalidated: false,
          mfaReset: false,
        },
        'identity.federated_identity_unlinked': {
          userId: m.user.id,
          provider: 'google',
        },
      };
      for (const [type, payload] of Object.entries(expected)) {
        const rows = await eventsOf(m.user.id, type);
        expect(rows).toHaveLength(1);
        expect(rows[0].payload).toMatchObject({
          eventId: expect.any(String),
          type,
          version: 1,
          occurredAt: expect.anything(),
          aggregateId: m.user.id,
          payload,
        });
        // Identifiers and flags only.
        const text = JSON.stringify(rows[0].payload);
        expect(text).not.toContain(secret);
        expect(text).not.toContain('ev@example.com');
        expect(text).not.toContain(m.email);
      }
    });

    it('rolls the state change back with its event when the event cannot be written', async () => {
      const m = await member();
      const { secret } = await enableSecondFactor(t(), m.user.id);
      const row = await secondFactorRow(t(), m.user.id);
      jest
        .spyOn(t().app.get(OutboxService), 'append')
        .mockRejectedValueOnce(new Error('outbox down'));

      await post('disable', m.token, { code: codeAt(t(), secret) }).expect(500);

      expect(await secondFactorRow(t(), m.user.id)).toEqual(row);
      expect(await eventsOf(m.user.id, 'identity.mfa_disabled')).toHaveLength(
        0,
      );
    });
  });
});
