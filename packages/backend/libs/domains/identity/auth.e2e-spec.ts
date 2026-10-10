import { getModelToken } from '@nestjs/sequelize';
import * as bcrypt from 'bcrypt';
import { generate } from 'otplib';
import { authSessionSchema } from '@marketplace-sandbox/contracts';
import {
  AuthTestApp,
  createAuthApp,
  decodeJwt,
  TEST_PASSWORD,
} from './testing/auth-app';
import User from './infra/models/user.model';
import SigningKey from './infra/models/signing-key.model';
import { KeyStore } from './infra/keys/key-store.service';

/**
 * Transitional (S01 T089): the scenarios of the old catch-all file now live in `auth-register`, `auth-login`,
 * `auth-tokens` and `auth-refresh`. What stays here until its own capability file exists: key rotation (S01 US7,
 * `auth-jwks-keys`). The second-factor case moved to S02's `mfa-*` files.
 */
describe('Auth sessions: key rotation (transitional)', () => {
  let t: AuthTestApp;
  let userModel: typeof User;
  let keyModel: typeof SigningKey;

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

  beforeAll(async () => {
    t = await createAuthApp();
    userModel = t.app.get(getModelToken(User));
    keyModel = t.app.get(getModelToken(SigningKey));
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await keyModel.destroy({ where: {} });
    t.app.get(KeyStore).invalidate();
  });

  it('key rotation: tokens signed by the previous key stay valid while it is RETIRED but published', async () => {
    const user = await t.seedUser();
    const session = await login(user.email!);
    const store = t.app.get(KeyStore);
    const [oldKey] = await keyModel.findAll({ where: { status: 'ACTIVE' } });

    const nextKid = await store.createKey('NEXT');
    await oldKey.update({ status: 'RETIRED', retiredAt: new Date() });
    await keyModel.update(
      { status: 'ACTIVE', activatedAt: new Date() },
      { where: { kid: nextKid! } },
    );
    store.invalidate();

    await t
      .http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.accessToken.token}`)
      .expect(200);
    const fresh = authSessionSchema.parse(
      (
        await t
          .http()
          .post('/api/auth/refresh')
          .send({ refreshToken: session.refreshToken })
          .expect(200)
      ).body,
    );
    expect(
      JSON.parse(
        Buffer.from(
          fresh.accessToken.token.split('.')[0],
          'base64url',
        ).toString(),
      ).kid,
    ).toBe(nextKid);
  });

  it('MFA: login returns a challenge; the TOTP code completes it; the same code cannot be replayed', async () => {
    const user = await t.seedUser();
    const session = await login(user.email!);
    const auth = { Authorization: `Bearer ${session.accessToken.token}` };

    // S02 contract: enroll answers 200 with the manual key (the sealed secret is bound to the user).
    const { manualEntryKey: secret } = (
      await t.http().post('/api/auth/mfa/enroll').set(auth).expect(200)
    ).body;

    const confirmCode = await generate({ secret });
    const { recoveryCodes } = (
      await t
        .http()
        .post('/api/auth/mfa/confirm')
        .set(auth)
        .send({ code: confirmCode })
        .expect(200)
    ).body;
    expect(recoveryCodes).toHaveLength(10);

    const challenge = (
      await t
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200)
    ).body;
    expect(challenge).toMatchObject({ mfaRequired: true });
    // The challenge token is not an access token.
    await t
      .http()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${challenge.mfaToken}`)
      .expect(401);

    // Same code as confirm → replay rejected; a recovery code works once.
    await t
      .http()
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: challenge.mfaToken, code: confirmCode })
      .expect(401);
    await t
      .http()
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: challenge.mfaToken, code: recoveryCodes[0] })
      .expect(200);
    await t
      .http()
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: challenge.mfaToken, code: recoveryCodes[0] })
      .expect(401);
  });

  // The remaining scenarios of the old catch-all file, kept as end-to-end regressions of the same behaviour
  // over the current contracts (registration is now a 202 without a session; no refresh grace window).
  describe('former catch-all regressions', () => {
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
    const refresh = (refreshToken: string) =>
      t.http().post('/api/auth/refresh').send({ refreshToken });

    it('login → ES256 access token with kid and session id; works on protected routes; JWKS never leaks private parts', async () => {
      const user = await t.seedUser();
      const session = await login(user.email!);
      const { header } = decodeJwt(session.accessToken.token);
      expect(header).toMatchObject({ alg: 'ES256' });
      expect(header.kid).toBeDefined();
      expect(session.sessionId).toBeDefined();

      const me = await t
        .http()
        .get('/api/auth/me')
        .set(bearer(session.accessToken.token))
        .expect(200);
      expect(me.body).toBeDefined();

      const jwks = await t.http().get('/.well-known/jwks.json').expect(200);
      expect(jwks.body.keys.map((k: { kid: string }) => k.kid)).toContain(
        header.kid,
      );
      expect(
        jwks.body.keys.every((k: { d?: string }) => k.d === undefined),
      ).toBe(true);
    });

    it('refresh rotates the token; replaying the spent one revokes the session and its newer token', async () => {
      const user = await t.seedUser();
      const session = await login(user.email!);

      const rotated = authSessionSchema.parse(
        (await refresh(session.refreshToken).expect(200)).body,
      );
      expect(rotated.refreshToken).not.toBe(session.refreshToken);
      expect(rotated.sessionId).toBe(session.sessionId);

      await refresh(session.refreshToken).expect(401);
      await refresh(rotated.refreshToken).expect(401);
      await t
        .http()
        .post('/api/auth/mfa/enroll')
        .set(bearer(rotated.accessToken.token))
        .expect(401);
    });

    it('logout-all revokes every session; the unexpired access token and the refresh tokens are refused at once', async () => {
      const user = await t.seedUser();
      const a = await login(user.email!);
      const b = await login(user.email!);
      expect(a.sessionId).not.toBe(b.sessionId);

      await t
        .http()
        .post('/api/auth/logout-all')
        .set(bearer(b.accessToken.token))
        .expect(200);

      await t
        .http()
        .post('/api/auth/mfa/enroll')
        .set(bearer(a.accessToken.token))
        .expect(401);
      await refresh(a.refreshToken).expect(401);
      await refresh(b.refreshToken).expect(401);
    });

    it('a legacy bcrypt hash still logs in and is upgraded to argon2id on the way', async () => {
      const email = 'legacy-bcrypt@example.com';
      await t.seedUser({
        email,
        passwordHash: await bcrypt.hash(TEST_PASSWORD, 10),
      });

      await t
        .http()
        .post('/api/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .expect(200);

      const stored = await userModel.findOne({ where: { email } });
      expect(stored!.passwordHash).toMatch(/^\$argon2id\$/);
      await t
        .http()
        .post('/api/auth/login')
        .send({ email, password: TEST_PASSWORD })
        .expect(200);
    });

    it('a wrong password and an unknown address give the same 401 (no user enumeration)', async () => {
      const user = await t.seedUser();
      const wrong = await t
        .http()
        .post('/api/auth/login')
        .send({ email: user.email, password: 'nope-nope-nope-nope' })
        .expect(401);
      const unknown = await t
        .http()
        .post('/api/auth/login')
        .send({ email: 'ghost@example.com', password: TEST_PASSWORD })
        .expect(401);
      expect(wrong.body.detail).toBe(unknown.body.detail);
      expect(wrong.body.status).toBe(unknown.body.status);
    });

    it('requests without a bearer, with a garbage bearer or with a tampered signature are refused', async () => {
      const user = await t.seedUser();
      const session = await login(user.email!);
      const [h, c, sig] = session.accessToken.token.split('.');

      await t.http().get('/api/auth/me').expect(401);
      await t.http().get('/api/auth/me').set(bearer('not-a-jwt')).expect(401);
      await t
        .http()
        .get('/api/auth/me')
        .set(bearer(`${h}.${c}.${sig.split('').reverse().join('')}`))
        .expect(401);
      await t
        .http()
        .get('/api/auth/me')
        .set(bearer(session.accessToken.token))
        .expect(200);
    });

    it('the published key set holds public EC keys only and at most one key is ACTIVE', async () => {
      const user = await t.seedUser();
      await login(user.email!);
      await t.app.get(KeyStore).createKey('NEXT');
      t.app.get(KeyStore).invalidate();
      const keys = await keyModel.findAll();
      expect(keys.filter((k) => k.status === 'ACTIVE')).toHaveLength(1);

      const jwks = await t.http().get('/.well-known/jwks.json').expect(200);
      expect(Array.isArray(jwks.body.keys)).toBe(true);
      for (const key of jwks.body.keys) {
        expect(key.kty).toBe('EC');
        expect(key.d).toBeUndefined();
      }
    });
  });
});
