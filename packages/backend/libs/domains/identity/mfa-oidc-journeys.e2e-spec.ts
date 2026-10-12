import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  authSessionSchema,
  mfaEnrollSchema,
  mfaRecoveryCodesSchema,
} from '@marketplace-sandbox/contracts';
import { authStore } from './testing/auth-app';
import { codeAt, flushRedis, passwordLogin } from './testing/mfa-fixtures';
import {
  FRONT,
  cookieValue,
  createOidcApp,
  OidcTestApp,
  setCookies,
  signIn,
} from './testing/oidc-fixtures';

const DOMAINS = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'node_modules' ? [] : sources(path);
    return /\.ts$/.test(name) && !/\.(e2e-)?spec\.ts$/.test(name) ? [path] : [];
  });
}

describe('Second factor and Google journeys, as the API sees them', () => {
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

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('S02 AS-63: no other domain touches the factor or federated-identity data, and the barrel hides the model and the engine', () => {
    const barrel = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(/\bFederatedIdentityModel\b/);
    expect(barrel).not.toMatch(/(?<!Provider)\bOidcService\b/);
    expect(barrel).toMatch(/\bOidcProviderRegistry\b/);

    const forbidden =
      /\b(FederatedIdentityModel|SecondFactorModel|MfaRecoveryCodeModel|MfaChallengeStateModel|OidcService)\b|"(FederatedIdentity|SecondFactor|MfaRecoveryCode|MfaChallengeState)"|\b(mfaSecretEnc|mfaEnabledAt|mfaRecoveryCodes)\b/;
    const offenders = readdirSync(DOMAINS)
      .filter((d) => d !== 'identity')
      .map((d) => join(DOMAINS, d))
      .filter((p) => statSync(p).isDirectory())
      .flatMap(sources)
      .filter((file) => forbidden.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('S02 AS-65: enrol, confirm, keep the recovery codes, log out, then log in with password and code', async () => {
    const t = app.t;
    const email = 'journey-mfa@example.com';
    const user = await t.seedUser({ email });
    const { accessToken } = await passwordLogin(t, email);

    const { manualEntryKey } = mfaEnrollSchema.parse(
      (
        await t
          .http()
          .post('/api/auth/mfa/enroll')
          .set(bearer(accessToken!))
          .expect(200)
      ).body,
    );
    const confirmed = await t
      .http()
      .post('/api/auth/mfa/confirm')
      .set(bearer(accessToken!))
      .send({ code: codeAt(t, manualEntryKey) })
      .expect(200);
    const { recoveryCodes } = mfaRecoveryCodesSchema.parse(confirmed.body);
    expect(recoveryCodes).toHaveLength(10);
    expect(confirmed.headers['cache-control']).toBe('no-store');

    // The codes are shown once: the status endpoint only counts them.
    const status = await t
      .http()
      .get('/api/auth/mfa')
      .set(bearer(accessToken!))
      .expect(200);
    expect(status.body).toMatchObject({ recoveryCodesRemaining: 10 });
    expect(JSON.stringify(status.body)).not.toContain(recoveryCodes[0]);

    await t
      .http()
      .post('/api/auth/logout')
      .set(bearer(accessToken!))
      .expect(204);

    const login = await passwordLogin(t, email);
    expect(login.accessToken).toBeUndefined();
    expect(login.mfaToken).toEqual(expect.any(String));

    t.clock.advance(30_000); // the confirming code's step is spent
    const verified = await t
      .http()
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: login.mfaToken, code: codeAt(t, manualEntryKey) })
      .expect(200);
    expect(authSessionSchema.parse(verified.body).user.id).toBe(user.id);
  });

  it('S02 AS-66: Continue with Google lands on the return page with a cookie session that the sessions list shows', async () => {
    const t = app.t;
    const { res } = await signIn(
      app,
      {
        sub: 'g-journey',
        email: 'journey-google@example.com',
        email_verified: true,
      },
      { returnTo: '/account/security' },
    );

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FRONT}/account/security`);
    expect(res.headers.location).not.toMatch(/token|code=|state=/);
    const access = cookieValue(setCookies(res)['__Host-access']);

    const list = await t
      .http()
      .get('/api/auth/sessions')
      .set({ Cookie: `__Host-access=${access}` })
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ current: true });
    expect(
      (await authStore(t.app).all()).filter((i) =>
        String(i.PK).startsWith('SESSION#'),
      ),
    ).toHaveLength(1);
  });
});
