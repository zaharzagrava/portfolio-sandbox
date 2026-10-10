import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  federatedIdentitySchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { authStore } from './testing/auth-app';
import {
  codeAt,
  enableSecondFactor,
  flushRedis,
  passwordLogin,
  recoveryRows,
  secondFactorRow,
} from './testing/mfa-fixtures';
import {
  FRONT,
  OidcTestApp,
  callback,
  cookieValue,
  createOidcApp,
  setCookies,
  sha256Hex,
  signIn,
  startFlow,
} from './testing/oidc-fixtures';
import { SessionRevocationService } from './application/session-revocation.service';

describe('Account linking', () => {
  let app: OidcTestApp;
  const counter = 0;

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

  const db = () => app.t.app.get(Sequelize);
  const rows = <T extends object>(text: string, bind: unknown[] = []) =>
    db().query<T>(text, { bind, type: QueryTypes.SELECT });
  const userCount = async () =>
    Number(
      (await rows<{ n: string }>(`SELECT count(*) AS n FROM "User"`))[0].n,
    );
  const links = () =>
    rows<{
      id: string;
      userId: string;
      provider: string;
      subject: string;
      email: string | null;
      wipePending: boolean;
    }>(`SELECT * FROM "FederatedIdentity" ORDER BY "createdAt"`);
  const sessionsOf = async (userId: string) =>
    (await authStore(app.t.app).all()).filter(
      (i) => String(i.PK).startsWith('SESSION#') && i.userId === userId,
    );
  const events = async (userId: string) =>
    (await outboxRowsFor(app.t.app, userId)).map((e) => e.payload);
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const errorOf = (res: { headers: Record<string, string> }) =>
    new URL(res.headers.location).searchParams.get('error');

  /** A password account with `n` live sessions. */
  async function passwordAccount(email: string, sessions = 2) {
    const user = await app.t.seedUser({ email });
    let token = '';
    for (let i = 0; i < sessions; i++)
      token = (await passwordLogin(app.t, email)).accessToken!;
    return { user, email, token };
  }

  /** A member created by Google, signed in; the token is the access cookie the callback set. */
  async function googleMember(sub: string, email: string) {
    const { res } = await signIn(app, { sub, email, email_verified: true });
    const token = cookieValue(setCookies(res)['__Host-access']);
    const [{ id }] = await rows<{ id: string }>(
      `SELECT "id" FROM "User" WHERE "email" = $1`,
      [email],
    );
    return { id, token };
  }

  describe('S02 AS-43: an address the provider did not verify', () => {
    it.each([
      ['unverified', { email: 'u@example.com', email_verified: false }],
      [
        'verified as the string "true"',
        { email: 'u@example.com', email_verified: 'true' },
      ],
      ['absent', { email_verified: true }],
    ])(
      'is refused when the claim is %s, and nothing is stored',
      async (_n, extra) => {
        const { res } = await signIn(app, { sub: 'g-u', ...extra });
        expect(errorOf(res)).toBe('email_not_verified');
        expect(await userCount()).toBe(0);
        expect(await links()).toHaveLength(0);
      },
    );
  });

  describe('S02 AS-47: soft-deleted accounts', () => {
    it('refuses a sign-in whose link belongs to a deleted user', async () => {
      const { id } = await googleMember('g-del', 'del@example.com');
      await db().query(
        `UPDATE "User" SET "deletedAt" = now() WHERE "id" = $1`,
        {
          bind: [id],
        },
      );

      const { res } = await signIn(app, {
        sub: 'g-del',
        email: 'del@example.com',
        email_verified: true,
      });

      expect(errorOf(res)).toBe('account_unavailable');
      expect(await userCount()).toBe(1);
      expect(await links()).toHaveLength(1);
    });

    it('refuses an address that belongs to a deleted user and creates no second account', async () => {
      const gone = await app.t.seedUser({ email: 'gone@example.com' });
      await gone.destroy();

      const { res } = await signIn(app, {
        sub: 'g-new',
        email: 'gone@example.com',
        email_verified: true,
      });

      expect(errorOf(res)).toBe('account_unavailable');
      expect(await userCount()).toBe(1);
      expect(await links()).toHaveLength(0);
    });
  });

  describe('S02 AS-44: a verified address that matches a password account', () => {
    async function victim() {
      const account = await passwordAccount('squat@example.com', 2);
      const factor = await enableSecondFactor(app.t, account.user.id);
      return { ...account, ...factor };
    }

    it('links, then removes the password, the factor and every earlier session, and says so in events', async () => {
      const v = await victim();
      expect(await sessionsOf(v.user.id)).toHaveLength(2);

      const { res } = await signIn(app, {
        sub: 'g-sq',
        email: 'squat@example.com',
        email_verified: true,
      });

      expect(res.headers.location).toBe(`${FRONT}/`);
      const [link] = await links();
      expect(link).toMatchObject({
        userId: v.user.id,
        provider: 'google',
        wipePending: false,
      });
      const [{ passwordHash }] = await rows<{ passwordHash: string | null }>(
        `SELECT "passwordHash" FROM "User" WHERE "id" = $1`,
        [v.user.id],
      );
      expect(passwordHash).toBeNull();
      expect(await secondFactorRow(app.t, v.user.id)).toBeUndefined();
      expect(await recoveryRows(app.t, v.user.id)).toHaveLength(0);

      const all = await sessionsOf(v.user.id);
      expect(all).toHaveLength(3);
      const revoked = all.filter((s) => s.revokedAt);
      expect(revoked).toHaveLength(2);
      for (const s of revoked) expect(s.revokeReason).toBe('account_linked');
      expect(all.filter((s) => !s.revokedAt)).toHaveLength(1);

      const payloads = await events(v.user.id);
      expect(payloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'identity.federated_identity_linked',
            payload: {
              userId: v.user.id,
              provider: 'google',
              linkMethod: 'email_match',
              passwordInvalidated: true,
              mfaReset: true,
            },
          }),
          expect.objectContaining({
            type: 'identity.mfa_disabled',
            payload: { userId: v.user.id, reason: 'account_linking' },
          }),
        ]),
      );
      // The old password no longer opens the account.
      await app.t
        .http()
        .post('/api/auth/login')
        .send({
          email: 'squat@example.com',
          password: 'correct horse battery staple',
        })
        .expect(401);
    });

    it('does not sign in while the revocation has not been confirmed, and finishes it at the next sign-in', async () => {
      const v = await victim();
      jest
        .spyOn(SessionRevocationService.prototype, 'revokeAllForUser')
        .mockRejectedValueOnce(new Error('store down'));

      const first = await signIn(app, {
        sub: 'g-sq',
        email: 'squat@example.com',
        email_verified: true,
      });

      expect(errorOf(first.res)).toBe('oidc_exchange_failed');
      expect(Object.keys(setCookies(first.res))).toEqual(['__Host-oidc-flow']);
      expect((await links())[0].wipePending).toBe(true);
      expect(
        (await sessionsOf(v.user.id)).filter((s) => !s.revokedAt),
      ).toHaveLength(2);

      const second = await signIn(app, {
        sub: 'g-sq',
        email: 'squat@example.com',
        email_verified: true,
      });

      expect(second.res.headers.location).toBe(`${FRONT}/`);
      expect((await links())[0].wipePending).toBe(false);
      const live = (await sessionsOf(v.user.id)).filter((s) => !s.revokedAt);
      expect(live).toHaveLength(1);
    });
  });

  describe('S02 AS-45: concurrency', () => {
    it('two first sign-ins of one person yield one account and one link', async () => {
      const flows = [await startFlow(app), await startFlow(app)];
      const claims = {
        sub: 'g-race',
        email: 'race@example.com',
        email_verified: true,
      };
      const backs = flows.map((f) =>
        app.provider.approve(f.authorizationUrl, claims),
      );

      const results = await Promise.all(
        backs.map((b, i) => callback(app, b, flows[i].flowCookie)),
      );

      for (const r of results) expect(r.headers.location).toBe(`${FRONT}/`);
      expect(await userCount()).toBe(1);
      expect(await links()).toHaveLength(1);
    });

    it('a registration and a Google sign-in for one address end in one account', async () => {
      const flow = await startFlow(app);
      const back = app.provider.approve(flow.authorizationUrl, {
        sub: 'g-reg',
        email: 'both@example.com',
        email_verified: true,
      });

      const [registered, signedIn] = await Promise.all([
        app.t.http().post('/api/auth/register').send({
          email: 'both@example.com',
          password: 'correct horse battery staple',
        }),
        callback(app, back, flow.flowCookie),
      ]);

      expect(registered.status).toBe(202);
      expect(signedIn.headers.location).toBe(`${FRONT}/`);
      expect(await userCount()).toBe(1);
      expect(await links()).toHaveLength(1);
    });
  });

  it("S02 AS-46: another subject of the same provider with a linked account's address is refused", async () => {
    await googleMember('g-1', 'twin@example.com');

    const { res } = await signIn(app, {
      sub: 'g-2',
      email: 'twin@example.com',
      email_verified: true,
    });

    expect(errorOf(res)).toBe('link_conflict');
    expect(await links()).toHaveLength(1);
    expect(await userCount()).toBe(1);
  });

  describe('S02 AS-49: starting an explicit link', () => {
    const linkStart = (token: string | undefined, body: object = {}) =>
      app.t
        .http()
        .post('/api/auth/oidc/google/link/start')
        .set(token ? bearer(token) : {})
        .send(body);

    it('needs a signed-in user', async () => {
      await linkStart(undefined).expect(401);
    });

    it('stores a link flow bound to the user and needs no code without a second factor', async () => {
      const { user, token } = await passwordAccount('plain@example.com', 1);

      const res = await linkStart(token, { returnTo: '/settings' }).expect(200);

      const state = new URL(res.body.authorizationUrl).searchParams.get(
        'state',
      )!;
      const stored = JSON.parse(
        (await app.t.app
          .get(RedisService)
          .client.get(`oidc:flow:${sha256Hex(state)}`))!,
      );
      expect(stored).toMatchObject({
        purpose: 'link',
        userId: user.id,
        returnPath: '/settings',
      });
      expect(setCookies(res)['__Host-oidc-flow']).toBeDefined();
    });

    it('needs the current code when a second factor is enabled, and consumes it', async () => {
      const { user, token } = await passwordAccount('guarded@example.com', 1);
      const { secret } = await enableSecondFactor(app.t, user.id);

      for (const body of [{}, { code: '000000' }]) {
        const res = await linkStart(token, body).expect(422);
        expect(problemDetailsSchema.parse(res.body).code).toBe('invalid_code');
      }
      const code = codeAt(app.t, secret, 1);
      await linkStart(token, { code }).expect(200);
      const replay = await linkStart(token, { code }).expect(422);
      expect(problemDetailsSchema.parse(replay.body).code).toBe('invalid_code');
    });
  });

  describe('S02 AS-50: the explicit link callback', () => {
    async function linkFlow(token: string, returnTo = '/account') {
      const res = await app.t
        .http()
        .post('/api/auth/oidc/google/link/start')
        .set(bearer(token))
        .send({ returnTo })
        .expect(200);
      return {
        authorizationUrl: res.body.authorizationUrl as string,
        flowCookie: cookieValue(setCookies(res)['__Host-oidc-flow']),
      };
    }

    it('links whatever the provider says about the address, issues no session and sets no cookie', async () => {
      const { user, token } = await passwordAccount('mine@example.com', 1);
      const flow = await linkFlow(token);
      const back = app.provider.approve(flow.authorizationUrl, {
        sub: 'g-5',
        email: 'somebody-else@example.com',
        email_verified: false,
      });
      const before = (await sessionsOf(user.id)).length;

      const res = await callback(app, back, flow.flowCookie);

      expect(res.headers.location).toBe(`${FRONT}/account?linked=google`);
      expect(Object.keys(setCookies(res))).toEqual(['__Host-oidc-flow']);
      expect((await sessionsOf(user.id)).length).toBe(before);
      expect(
        (await sessionsOf(user.id)).filter((s) => s.revokedAt),
      ).toHaveLength(0);
      expect(await links()).toEqual([
        expect.objectContaining({ userId: user.id, subject: 'g-5' }),
      ]);
      expect(await events(user.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'identity.federated_identity_linked',
            payload: {
              userId: user.id,
              provider: 'google',
              linkMethod: 'explicit',
              passwordInvalidated: false,
              mfaReset: false,
            },
          }),
        ]),
      );
    });

    it('refuses a subject that belongs to another user', async () => {
      await googleMember('g-5', 'owner@example.com');
      const { token } = await passwordAccount('thief@example.com', 1);
      const flow = await linkFlow(token);
      const back = app.provider.approve(flow.authorizationUrl, {
        sub: 'g-5',
        email: 'owner@example.com',
        email_verified: true,
      });

      const res = await callback(app, back, flow.flowCookie);

      expect(errorOf(res)).toBe('identity_already_linked');
      expect(await links()).toHaveLength(1);
    });

    it('refuses a second identity of the same provider', async () => {
      const mine = await googleMember('g-first', 'first@example.com');
      const flow = await linkFlow(mine.token);
      const back = app.provider.approve(flow.authorizationUrl, {
        sub: 'g-second',
        email: 'second@example.com',
        email_verified: true,
      });

      const res = await callback(app, back, flow.flowCookie);

      expect(errorOf(res)).toBe('link_conflict');
      expect(await links()).toHaveLength(1);
    });

    it('refuses the callback of another browser', async () => {
      const { token } = await passwordAccount('browser@example.com', 1);
      const flow = await linkFlow(token);
      const back = app.provider.approve(flow.authorizationUrl, {
        sub: 'g-b',
        email: 'b@example.com',
        email_verified: true,
      });

      const res = await callback(app, back, 'someone-elses-cookie');

      expect(errorOf(res)).toBe('oidc_state_invalid');
      expect(await links()).toHaveLength(0);
    });
  });

  describe('S02 AS-51: the list of linked identities', () => {
    it("returns the caller's identities only and needs a token", async () => {
      const a = await googleMember('g-a', 'a@example.com');
      await googleMember('g-b', 'b@example.com');

      const res = await app.t
        .http()
        .get('/api/auth/identities')
        .set(bearer(a.token))
        .expect(200);

      const list = federatedIdentitySchema.array().parse(res.body);
      expect(list).toEqual([
        expect.objectContaining({ provider: 'google', email: 'a@example.com' }),
      ]);
      await app.t.http().get('/api/auth/identities').expect(401);
    });
  });

  describe('S02 AS-52: unlinking', () => {
    const unlink = (token: string | undefined, id: string) =>
      app.t
        .http()
        .delete(`/api/auth/identities/${id}`)
        .set(token ? bearer(token) : {});

    it("answers an identical 404 for another user's, an unknown and a malformed id", async () => {
      const a = await googleMember('g-a', 'a@example.com');
      await googleMember('g-b', 'b@example.com');
      const [, other] = await links();

      const bodies: unknown[] = [];
      for (const id of [
        other.id,
        '00000000-0000-4000-8000-000000000000',
        'not-a-uuid',
      ]) {
        const res = await unlink(a.token, id).expect(404);
        expect(problemDetailsSchema.parse(res.body).code).toBe(
          'identity_not_found',
        );
        const { type, title, status, detail, code } = res.body;
        bodies.push({ type, title, status, detail, code });
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(await links()).toHaveLength(2);
    });

    it('refuses to remove the last way to sign in', async () => {
      const a = await googleMember('g-a', 'a@example.com');
      const [link] = await links();

      const res = await unlink(a.token, link.id).expect(409);

      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'last_login_method',
      );
      expect(await links()).toHaveLength(1);
    });

    it('lets a member with a password unlink their only identity, once', async () => {
      const { user, token } = await passwordAccount('both-ways@example.com', 1);
      const flow = await app.t
        .http()
        .post('/api/auth/oidc/google/link/start')
        .set(bearer(token))
        .send({})
        .expect(200);
      const back = app.provider.approve(flow.body.authorizationUrl, {
        sub: 'g-bw',
        email: 'bw@example.com',
        email_verified: true,
      });
      await callback(
        app,
        back,
        cookieValue(setCookies(flow)['__Host-oidc-flow']),
      );
      const [link] = await links();

      await unlink(token, link.id).expect(204);

      expect(await links()).toHaveLength(0);
      expect(await events(user.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'identity.federated_identity_unlinked',
            payload: { userId: user.id, provider: 'google' },
          }),
        ]),
      );
      await unlink(token, link.id).expect(404);
    });

    it('needs a token', async () => {
      await unlink(undefined, '00000000-0000-4000-8000-000000000000').expect(
        401,
      );
    });
  });

  describe('S02 AS-53: the store itself refuses duplicates', () => {
    const insert = (userId: string, provider: string, subject: string) =>
      db().query(
        `INSERT INTO "FederatedIdentity" ("userId","provider","subject","createdAt") VALUES ($1,$2,$3,now())`,
        { bind: [userId, provider, subject] },
      );

    it('rejects a second (provider, subject) and a second (userId, provider)', async () => {
      const a = await app.t.seedUser({ email: 'a@example.com' });
      const b = await app.t.seedUser({ email: 'b@example.com' });
      await insert(a.id, 'google', 'g-1');

      const unique = { name: 'SequelizeUniqueConstraintError' };
      await expect(insert(b.id, 'google', 'g-1')).rejects.toMatchObject(unique);
      await expect(insert(a.id, 'google', 'g-2')).rejects.toMatchObject(unique);
      await insert(b.id, 'google', 'g-3');
    });

    it('reports the offending pairs when duplicates pre-exist (the migration check)', async () => {
      const a = await app.t.seedUser({ email: 'dup@example.com' });
      await db().query(`DROP INDEX "FederatedIdentity_user_provider_uq"`);
      try {
        await insert(a.id, 'google', 'g-1');
        await insert(a.id, 'google', 'g-2');
        const duplicates = await rows<{
          userId: string;
          provider: string;
          n: string;
        }>(
          `SELECT "userId","provider",count(*) AS n FROM "FederatedIdentity"
           GROUP BY "userId","provider" HAVING count(*) > 1`,
        );
        expect(duplicates).toEqual([
          { userId: a.id, provider: 'google', n: '2' },
        ]);
      } finally {
        await db().query(`TRUNCATE "FederatedIdentity"`);
        await db().query(
          `CREATE UNIQUE INDEX "FederatedIdentity_user_provider_uq" ON "FederatedIdentity" ("userId","provider")`,
        );
      }
    });
  });
});
