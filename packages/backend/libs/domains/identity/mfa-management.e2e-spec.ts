import {
  mfaRecoveryCodesSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import {
  codeAt,
  enableSecondFactor,
  flushRedis,
  passwordLogin,
  recoveryRows,
  secondFactorRow,
} from './testing/mfa-fixtures';

describe('S02 second factor management (regenerate, disable)', () => {
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

  async function enabledMember() {
    const email = `manage-${++counter}@example.com`;
    const user = await t.seedUser({ email });
    const { accessToken } = await passwordLogin(t, email);
    const factor = await enableSecondFactor(t, user.id);
    return { user, email, token: accessToken!, ...factor };
  }
  const post = (path: string, token: string | undefined, body: unknown) =>
    t
      .http()
      .post(`/api/auth/mfa/${path}`)
      .set(token ? bearer(token) : {})
      .send(body as object);
  const regenerate = (token: string | undefined, body: unknown) =>
    post('recovery-codes/regenerate', token, body);
  const disable = (token: string | undefined, body: unknown) =>
    post('disable', token, body);
  const events = async (userId: string, type: string) =>
    (await outboxRowsFor(t.app, userId)).filter((e) => e.type === type);

  it('S02 AS-25: regenerate with a valid TOTP code returns 10 new codes, kills the old ones and appends one event', async () => {
    const m = await enabledMember();
    const res = await regenerate(m.token, { code: codeAt(t, m.secret) }).expect(
      200,
    );
    const { recoveryCodes } = mfaRecoveryCodesSchema.parse(res.body);
    expect(recoveryCodes).toHaveLength(10);
    for (const old of m.recoveryCodes) expect(recoveryCodes).not.toContain(old);
    const rows = await recoveryRows(t, m.user.id);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
    expect(
      await events(m.user.id, 'identity.mfa_recovery_codes_regenerated'),
    ).toHaveLength(1);
  });

  it('S02 AS-25: regenerate is 409 mfa_not_enabled without a factor and 422 invalid_code on a wrong code, with no event', async () => {
    const email = `manage-none-${++counter}@example.com`;
    await t.seedUser({ email });
    const { accessToken } = await passwordLogin(t, email);
    const none = await regenerate(accessToken, { code: '123456' }).expect(409);
    expect(none.body.code).toBe('mfa_not_enabled');

    const m = await enabledMember();
    const wrong = await regenerate(m.token, { code: '000000' }).expect(422);
    expect(problemDetailsSchema.parse(wrong.body).code).toBe('invalid_code');
    expect(
      await events(m.user.id, 'identity.mfa_recovery_codes_regenerated'),
    ).toHaveLength(0);
  });

  it('S02 AS-26: disable with a TOTP code is 204, deletes the factor and codes and appends mfa_disabled{user}', async () => {
    const m = await enabledMember();
    await disable(m.token, { code: codeAt(t, m.secret) }).expect(204);
    expect(await secondFactorRow(t, m.user.id)).toBeUndefined();
    expect(await recoveryRows(t, m.user.id)).toHaveLength(0);
    const disabled = await events(m.user.id, 'identity.mfa_disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0].payload).toMatchObject({
      payload: { userId: m.user.id, reason: 'user' },
    });
    expect(await events(m.user.id, 'identity.mfa_recovery_code_used')).toEqual(
      [],
    );
  });

  it('S02 AS-26: disable with an unspent recovery code is 204 and also appends mfa_recovery_code_used', async () => {
    const m = await enabledMember();
    await disable(m.token, { code: m.recoveryCodes[2] }).expect(204);
    expect(await secondFactorRow(t, m.user.id)).toBeUndefined();
    expect(await events(m.user.id, 'identity.mfa_disabled')).toHaveLength(1);
    expect(
      await events(m.user.id, 'identity.mfa_recovery_code_used'),
    ).toHaveLength(1);
  });

  it('S02 AS-26: disable is 409 mfa_not_enabled without a factor and 422 invalid_code on a wrong code', async () => {
    const email = `manage-none-${++counter}@example.com`;
    await t.seedUser({ email });
    const { accessToken } = await passwordLogin(t, email);
    const none = await disable(accessToken, { code: '123456' }).expect(409);
    expect(none.body.code).toBe('mfa_not_enabled');

    const m = await enabledMember();
    const wrong = await disable(m.token, { code: '000000' }).expect(422);
    expect(wrong.body.code).toBe('invalid_code');
    expect(await secondFactorRow(t, m.user.id)).toBeDefined();
    expect(await events(m.user.id, 'identity.mfa_disabled')).toHaveLength(0);
  });

  it('S02 AS-27: a recovery code cannot regenerate, a TOTP step cannot be used twice, and two parallel disables give one 204, one 409 and one event', async () => {
    const m = await enabledMember();
    const viaRecovery = await regenerate(m.token, {
      code: m.recoveryCodes[0],
    }).expect(422);
    expect(viaRecovery.body.code).toBe('invalid_code');

    const code = codeAt(t, m.secret);
    await regenerate(m.token, { code }).expect(200);
    const reused = await regenerate(m.token, { code }).expect(422);
    expect(reused.body.code).toBe('invalid_code');

    t.clock.advance(31_000);
    const fresh = codeAt(t, m.secret);
    const results = await Promise.all([
      disable(m.token, { code: fresh }),
      disable(m.token, { code: fresh }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(await events(m.user.id, 'identity.mfa_disabled')).toHaveLength(1);
  });
});
