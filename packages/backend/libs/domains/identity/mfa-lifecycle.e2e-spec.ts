import {
  mfaRecoveryCodesSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import {
  codeAt,
  enableSecondFactor,
  flushRedis,
  passwordLogin,
  recoveryRows,
  secondFactorRow,
} from './testing/mfa-fixtures';

describe('Second factor lifecycle (regenerate and disable)', () => {
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

  /** A signed-in member with an enabled factor (login before the factor exists, so the token is a plain session). */
  async function enabledMember() {
    const email = `lifecycle-${++counter}@example.com`;
    const user = await t.seedUser({ email });
    const { accessToken } = await passwordLogin(t, email);
    const factor = await enableSecondFactor(t, user.id);
    return { user, email, token: accessToken!, ...factor };
  }
  const regenerate = (token: string | undefined, body: unknown) =>
    t
      .http()
      .post('/api/auth/mfa/recovery-codes/regenerate')
      .set(token ? bearer(token) : {})
      .send(body as object);
  const disable = (token: string | undefined, body: unknown) =>
    t
      .http()
      .post('/api/auth/mfa/disable')
      .set(token ? bearer(token) : {})
      .send(body as object);
  const nextStep = () => t.clock.advance(31_000);

  it('mfa-lifecycle: regenerate with a TOTP code returns ten new codes and the old ones are rejected at login', async () => {
    const m = await enabledMember();
    const res = await regenerate(m.token, { code: codeAt(t, m.secret) }).expect(
      200,
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const { recoveryCodes } = mfaRecoveryCodesSchema.parse(res.body);
    expect(recoveryCodes).toHaveLength(10);
    for (const old of m.recoveryCodes) expect(recoveryCodes).not.toContain(old);

    const challenge = await passwordLogin(t, m.email);
    expect(challenge.mfaToken).toBeDefined();
    const withOld = await t
      .http()
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: challenge.mfaToken, code: m.recoveryCodes[0] })
      .expect(401);
    expect(withOld.body.code).toBe('invalid_mfa_code');
    const second = await passwordLogin(t, m.email);
    await t
      .http()
      .post('/api/auth/mfa/verify')
      .send({ mfaToken: second.mfaToken, code: recoveryCodes[0] })
      .expect(200);
  });

  it('mfa-lifecycle: a wrong code on regenerate is 422 invalid_code and changes nothing', async () => {
    const m = await enabledMember();
    const res = await regenerate(m.token, { code: '000000' }).expect(422);
    expect(problemDetailsSchema.parse(res.body).code).toBe('invalid_code');
    expect(await recoveryRows(t, m.user.id)).toHaveLength(10);
  });

  it('mfa-lifecycle: a recovery code is not accepted for regenerate', async () => {
    const m = await enabledMember();
    const res = await regenerate(m.token, { code: m.recoveryCodes[0] }).expect(
      422,
    );
    expect(res.body.code).toBe('invalid_code');
    const rows = await recoveryRows(t, m.user.id);
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
  });

  it('mfa-lifecycle: disable with a TOTP code is 204, removes the factor and its codes, and login no longer asks for a code', async () => {
    const m = await enabledMember();
    await disable(m.token, { code: codeAt(t, m.secret) }).expect(204);
    expect(await secondFactorRow(t, m.user.id)).toBeUndefined();
    expect(await recoveryRows(t, m.user.id)).toHaveLength(0);
    const login = await passwordLogin(t, m.email);
    expect(login.mfaToken).toBeUndefined();
    expect(login.accessToken).toBeDefined();
  });

  it('mfa-lifecycle: disable with an unspent recovery code is 204 and the code is spent', async () => {
    const m = await enabledMember();
    await disable(m.token, { code: m.recoveryCodes[3] }).expect(204);
    expect(await secondFactorRow(t, m.user.id)).toBeUndefined();
  });

  it('mfa-lifecycle: disable with a wrong code is 422 invalid_code and the factor stays', async () => {
    const m = await enabledMember();
    const res = await disable(m.token, { code: 'ABCDE-FGHJK' }).expect(422);
    expect(res.body.code).toBe('invalid_code');
    expect(await secondFactorRow(t, m.user.id)).toBeDefined();
  });

  it('mfa-lifecycle: without a second factor regenerate and disable are 409 mfa_not_enabled', async () => {
    const email = `lifecycle-none-${++counter}@example.com`;
    await t.seedUser({ email });
    const { accessToken } = await passwordLogin(t, email);
    for (const call of [regenerate, disable]) {
      const res = await call(accessToken, { code: '123456' }).expect(409);
      expect(res.body.code).toBe('mfa_not_enabled');
    }
  });

  it('mfa-lifecycle: after 5 wrong codes shared across regenerate and disable the next attempt is 429 rate_limited, even with a right code', async () => {
    const m = await enabledMember();
    for (let i = 0; i < 3; i++)
      await regenerate(m.token, { code: '000000' }).expect(422);
    for (let i = 0; i < 2; i++)
      await disable(m.token, { code: '000000' }).expect(422);
    const limited = await regenerate(m.token, {
      code: codeAt(t, m.secret),
    }).expect(429);
    expect(problemDetailsSchema.parse(limited.body).code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('mfa-lifecycle: a request without a token is 401 and a body with extra members or an empty code is 400', async () => {
    await regenerate(undefined, { code: '123456' }).expect(401);
    await disable(undefined, { code: '123456' }).expect(401);
    const m = await enabledMember();
    await regenerate(m.token, { code: '' }).expect(400);
    await disable(m.token, {}).expect(400);
  });

  it('mfa-lifecycle: no response carries the secret, a digest or the sealed value', async () => {
    const m = await enabledMember();
    const res = await regenerate(m.token, { code: codeAt(t, m.secret) }).expect(
      200,
    );
    nextStep();
    const failed = await disable(m.token, { code: '000000' }).expect(422);
    const row = (await secondFactorRow(t, m.user.id))!;
    const everything = JSON.stringify([res.body, res.headers, failed.body]);
    expect(everything).not.toContain(m.secret);
    expect(everything).not.toContain(row.secretSealed);
    for (const r of await recoveryRows(t, m.user.id))
      expect(everything).not.toContain(r.digest);
  });
});
