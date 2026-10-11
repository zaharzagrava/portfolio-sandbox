import {
  problemDetailsSchema,
  sessionListItemSchema,
} from '@marketplace-sandbox/contracts';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import { flushRedis, passwordLogin } from './testing/mfa-fixtures';

describe('Session revocation', () => {
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
  const list = (token: string) =>
    t.http().get('/api/auth/sessions').set(bearer(token));
  const revoke = (token: string | undefined, sessionId: string) =>
    t
      .http()
      .delete(`/api/auth/sessions/${sessionId}`)
      .set(token ? bearer(token) : {});
  /** A sensitive route checks revocation on every call. */
  const probe = (token: string) =>
    t.http().get('/api/auth/mfa').set(bearer(token));

  async function member() {
    const email = `revoke-${++counter}@example.com`;
    await t.seedUser({ email });
    return email;
  }
  /** Two devices of one user; returns the current session id seen from the first. */
  async function twoDevices() {
    const email = await member();
    const first = (await passwordLogin(t, email)).accessToken!;
    const second = (await passwordLogin(t, email)).accessToken!;
    const sessions = (await list(first).expect(200)).body.map((s: unknown) =>
      sessionListItemSchema.parse(s),
    );
    const other = sessions.find((s: { current: boolean }) => !s.current)!;
    const current = sessions.find((s: { current: boolean }) => s.current)!;
    return { first, second, other, current, email };
  }

  it('sessions-revoke: revoking another device returns 204, drops it from the list and its next request is 401', async () => {
    const { first, second, other } = await twoDevices();
    await probe(second).expect(200);

    await revoke(first, other.sessionId).expect(204);

    await probe(second).expect(401);
    await probe(first).expect(200);
    const after = (await list(first).expect(200)).body;
    expect(after).toHaveLength(1);
    expect(after[0].current).toBe(true);
  });

  it("sessions-revoke: another user's session id is 404 session_not_found and stays active", async () => {
    const mine = await twoDevices();
    const stranger = (await passwordLogin(t, await member())).accessToken!;

    const res = await revoke(stranger, mine.other.sessionId).expect(404);

    expect(problemDetailsSchema.parse(res.body).code).toBe('session_not_found');
    await probe(mine.second).expect(200);
  });

  it('sessions-revoke: an unknown id is 404 session_not_found', async () => {
    const { first } = await twoDevices();
    const res = await revoke(first, 'does-not-exist').expect(404);
    expect(problemDetailsSchema.parse(res.body).code).toBe('session_not_found');
  });

  it('sessions-revoke: revoking an already revoked session is 404 session_not_found', async () => {
    const { first, other } = await twoDevices();
    await revoke(first, other.sessionId).expect(204);
    const again = await revoke(first, other.sessionId).expect(404);
    expect(again.body.code).toBe('session_not_found');
  });

  it('sessions-revoke: without a token it is 401', async () => {
    await revoke(undefined, 'any').expect(401);
  });

  it('sessions-revoke: the list items match the shared schema (device, ip and lastUsedAt may be null)', async () => {
    const { first } = await twoDevices();
    const body = (await list(first).expect(200)).body;
    expect(body).toHaveLength(2);
    for (const item of body) sessionListItemSchema.parse(item);
  });
});
