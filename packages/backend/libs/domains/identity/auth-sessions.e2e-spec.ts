import {
  authSessionSchema,
  problemDetailsSchema,
  sessionListItemSchema,
} from '@marketplace-sandbox/contracts';
import { authStore, AuthTestApp, createAuthApp } from './testing/auth-app';
import { flushRedis } from './testing/mfa-fixtures';
import { SessionIssuer } from './application/session-issuer.service';
import { SessionRevocationService } from './application/session-revocation.service';

describe('Sessions', () => {
  let t: AuthTestApp;
  let store: ReturnType<typeof authStore>;
  let issuer: SessionIssuer;

  beforeAll(async () => {
    t = await createAuthApp();
    store = authStore(t.app);
    issuer = t.app.get(SessionIssuer);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const open = async (userId: string, device = 'jest') => {
    t.clock.advance(1000); // distinct creation times: the list is ordered by them
    return issuer.issue({ userId, amr: ['pwd'], meta: { device } });
  };
  const refresh = (refreshToken: string) =>
    t.http().post('/api/auth/refresh').send({ refreshToken });

  it('S01 AS-39: the list holds only the caller’s active sessions, newest first, in the documented shape', async () => {
    const a = await t.seedUser();
    const b = await t.seedUser();
    const [s1, s2, s3, gone] = [
      await open(a.id, 'one'),
      await open(a.id, 'two'),
      await open(a.id, 'three'),
      await open(a.id, 'revoked'),
    ];
    await open(b.id, 'other-user');
    await t
      .http()
      .delete(`/api/auth/sessions/${gone.sessionId}`)
      .set(bearer(s3.accessToken.token))
      .expect(204);

    const res = await t
      .http()
      .get('/api/auth/sessions')
      .set(bearer(s2.accessToken.token))
      .expect(200);

    const items = res.body.map((i: unknown) => sessionListItemSchema.parse(i));
    expect(items.map((i: { sessionId: string }) => i.sessionId)).toEqual([
      s3.sessionId,
      s2.sessionId,
      s1.sessionId,
    ]);
    expect(
      items
        .filter((i: { current: boolean }) => i.current)
        .map((i: { sessionId: string }) => i.sessionId),
    ).toEqual([s2.sessionId]);
    for (const item of res.body)
      expect(Object.keys(item).sort()).toEqual([
        'createdAt',
        'current',
        'device',
        'ip',
        'lastUsedAt',
        'sessionId',
      ]);
    const text = JSON.stringify(res.body);
    for (const leak of [a.id, b.id, 'SESSION#', 'GSI1', 'familyId', 'RT#'])
      expect(text).not.toContain(leak);
  });

  it('S01 AS-40: another user’s session id answers like an unknown one and stays active', async () => {
    const a = await open((await t.seedUser()).id);
    const b = await open((await t.seedUser()).id);

    const foreign = await t
      .http()
      .delete(`/api/auth/sessions/${b.sessionId}`)
      .set(bearer(a.accessToken.token))
      .expect(404);
    const unknown = await t
      .http()
      .delete('/api/auth/sessions/00000000-0000-7000-8000-000000000000')
      .set(bearer(a.accessToken.token))
      .expect(404);

    expect(problemDetailsSchema.parse(foreign.body).code).toBe(
      'session_not_found',
    );
    expect({
      ...foreign.body,
      instance: undefined,
      requestId: undefined,
      detail: undefined,
    }).toEqual({
      ...unknown.body,
      instance: undefined,
      requestId: undefined,
      detail: undefined,
    });
    expect((await store.session(b.sessionId))?.revokedAt).toBeUndefined();
    await refresh(b.refreshToken).expect(200);
  });

  it('S01 AS-41: revoking another own session ends it; revoking the current one behaves as logout', async () => {
    const user = await t.seedUser();
    const s1 = await open(user.id);
    const s2 = await open(user.id);

    await t
      .http()
      .delete(`/api/auth/sessions/${s2.sessionId}`)
      .set(bearer(s1.accessToken.token))
      .expect(204);

    await refresh(s2.refreshToken).expect(401);
    const still = authSessionSchema.parse(
      (await refresh(s1.refreshToken).expect(200)).body,
    );

    await t
      .http()
      .delete(`/api/auth/sessions/${s1.sessionId}`)
      .set(bearer(still.accessToken.token))
      .expect(204);
    await refresh(still.refreshToken).expect(401);
    expect((await store.session(s1.sessionId))?.revokedAt).toEqual(
      expect.any(String),
    );
  });

  it('S01 AS-42: logging out twice is 204 both times and keeps the first revocation time and reason', async () => {
    const s = await open((await t.seedUser()).id);
    const logout = () =>
      t.http().post('/api/auth/logout').set(bearer(s.accessToken.token));

    await logout().expect(204);
    const first = await store.session(s.sessionId);
    t.clock.advance(5000);
    await logout().expect(204);

    const second = await store.session(s.sessionId);
    expect(first).toMatchObject({ revokeReason: 'logout' });
    expect(second?.revokedAt).toBe(first?.revokedAt);
    expect(second?.revokeReason).toBe('logout');
    await refresh(s.refreshToken).expect(401);
  });

  it('S01 AS-43: logout-all ends every session of the caller, only theirs, and is idempotent', async () => {
    const a = await t.seedUser();
    const b = await t.seedUser();
    const mine = [await open(a.id), await open(a.id), await open(a.id)];
    const theirs = await open(b.id);

    const res = await t
      .http()
      .post('/api/auth/logout-all')
      .set(bearer(mine[2].accessToken.token))
      .expect(200);

    expect(res.body).toEqual({ revokedSessions: 3 });
    for (const s of mine) await refresh(s.refreshToken).expect(401);
    for (const s of mine)
      await t
        .http()
        .post('/api/auth/logout-all')
        .set(bearer(s.accessToken.token))
        .expect(401); // sensitive: revoked now
    await refresh(theirs.refreshToken).expect(200);
    expect(
      await t.app.get(SessionRevocationService).revokeAllForUser(a.id, 'again'),
    ).toBe(0);
  });

  it('S01 AS-44: the 21st session evicts the oldest with reason session_limit', async () => {
    const user = await t.seedUser();
    const sessions: Awaited<ReturnType<typeof open>>[] = [];
    for (let i = 0; i < 20; i++) sessions.push(await open(user.id, `d${i}`));
    const extra = await open(user.id, 'newest');

    expect(await store.session(sessions[0].sessionId)).toMatchObject({
      revokedAt: expect.any(String),
      revokeReason: 'session_limit',
    });
    await refresh(sessions[0].refreshToken).expect(401);
    await refresh(sessions[1].refreshToken).expect(200);
    const list = await t
      .http()
      .get('/api/auth/sessions')
      .set(bearer(extra.accessToken.token))
      .expect(200);
    expect(list.body).toHaveLength(20);
  });

  it('S01 AS-45: revokeAllForUser counts what it revoked, records the reason and kills the refresh tokens', async () => {
    const user = await t.seedUser();
    const sessions = [await open(user.id), await open(user.id)];

    const count = await t.app
      .get(SessionRevocationService)
      .revokeAllForUser(user.id, 'admin_ban');

    expect(count).toBe(2);
    for (const s of sessions) {
      expect(await store.session(s.sessionId)).toMatchObject({
        revokeReason: 'admin_ban',
      });
      await refresh(s.refreshToken).expect(401);
    }
  });
});
