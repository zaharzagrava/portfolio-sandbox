import { createSign, generateKeyPairSync } from 'node:crypto';
import { getModelToken } from '@nestjs/sequelize';
import {
  authSessionSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { AuthTestApp, createAuthApp, TEST_PASSWORD } from './testing/auth-app';
import { AuthProbeModule } from './testing/probe.module';
import { RevocationMarkers } from './infra/sessions/revocation-markers';
import User, { Role } from './infra/models/user.model';

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const stranger = generateKeyPairSync('ec', { namedCurve: 'P-256' });

describe('Token authentication', () => {
  let t: AuthTestApp;
  let userModel: typeof User;

  const loginAs = async (email: string) =>
    authSessionSchema.parse(
      (
        await t
          .http()
          .post('/api/auth/login')
          .send({ email, password: TEST_PASSWORD })
          .expect(200)
      ).body,
    );
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await createAuthApp({ extraImports: [AuthProbeModule] });
    userModel = t.app.get(getModelToken(User));
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
  });

  describe('S01 AS-24: one answer for every failure', () => {
    const forged = (
      header: Record<string, unknown>,
      claims: Record<string, unknown>,
    ) => {
      const input = `${b64(header)}.${b64(claims)}`;
      return `${input}.${createSign('sha256').update(input).sign({ key: stranger.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    };
    const claims = (iat: number) => ({
      iss: 'marketplace',
      aud: 'marketplace-api',
      sub: 'u',
      sid: 's',
      role: 'USER',
      amr: ['pwd'],
      iat,
      nbf: iat,
      exp: iat + 300,
    });

    it('alg none, unknown kid and expired tokens are the same 401 invalid_token with no hint', async () => {
      const user = await t.seedUser();
      const session = await loginAs(user.email!);
      const now = Math.floor(Date.now() / 1000);

      const bodies = [] as Record<string, unknown>[];
      const send = async (token: string) => {
        const res = await t
          .http()
          .get('/api/probe/ordinary')
          .set(bearer(token))
          .expect(401);
        bodies.push(res.body);
        return res;
      };
      await send(
        `${b64({ alg: 'none', typ: 'at+jwt', kid: 'k1' })}.${b64(claims(now))}.`,
      );
      await send(
        forged(
          { alg: 'ES256', typ: 'at+jwt', kid: 'unknown-key' },
          claims(now),
        ),
      );
      t.clock.advance(10 * 60_000);
      await send(session.accessToken.token); // genuine, now past exp + tolerance

      const strip = ({
        requestId: _r,
        instance: _i,
        traceId: _t,
        ...rest
      }: Record<string, unknown>) => rest;
      expect(strip(bodies[1])).toEqual(strip(bodies[0]));
      expect(strip(bodies[2])).toEqual(strip(bodies[0]));
      expect(problemDetailsSchema.parse(bodies[0]).code).toBe('invalid_token');
      for (const body of bodies)
        expect(JSON.stringify(body)).not.toMatch(
          /expired|signature|kid|jwt|alg/i,
        );
    });

    it('an optional-auth route continues anonymously on a bad token', async () => {
      const res = await t
        .http()
        .get('/api/probe/optional')
        .set(bearer('garbage.token.here'))
        .expect(200);
      expect(res.body.user).toBeNull();
    });

    it('an optional-auth route knows the user on a good token', async () => {
      const user = await t.seedUser();
      const session = await loginAs(user.email!);
      const res = await t
        .http()
        .get('/api/probe/optional')
        .set(bearer(session.accessToken.token))
        .expect(200);
      expect(res.body.user).toMatchObject({ id: user.id, role: 'USER' });
    });
  });

  it('S01 AS-25: client identity headers never choose the principal', async () => {
    const a = await t.seedUser();
    const b = await t.seedUser();
    const session = await loginAs(a.email!);
    const headers = {
      ...bearer(session.accessToken.token),
      'X-User-Id': b.id,
      'X-Tenant-Id': 'tenant-1',
      'X-Forwarded-User': b.id,
    };

    const res = await t
      .http()
      .get('/api/probe/ordinary')
      .set(headers)
      .expect(200);
    expect(res.body.user).toEqual({
      id: a.id,
      role: 'USER',
      sessionId: session.sessionId,
      amr: ['pwd'],
    });

    await t
      .http()
      .get('/api/probe/ordinary')
      .set({
        'X-User-Id': b.id,
        'X-Tenant-Id': 'tenant-1',
        'X-Forwarded-User': b.id,
      })
      .expect(401);
  });

  it('S01 AS-26: only Authorization Bearer and the __Host-access cookie carry a credential', async () => {
    const user = await t.seedUser();
    const { token } = { token: (await loginAs(user.email!)).accessToken.token };

    await t
      .http()
      .get('/api/probe/ordinary')
      .set({ 'x-auth-token': token })
      .expect(401);
    await t
      .http()
      .get('/api/probe/ordinary')
      .set({ Cookie: `x-auth-token=${token}` })
      .expect(401);
    await t.http().get(`/api/probe/ordinary?token=${token}`).expect(401);
    await t.http().get('/api/probe/ordinary').set(bearer(token)).expect(200);
    await t
      .http()
      .get('/api/probe/ordinary')
      .set({ Cookie: `__Host-access=${token}` })
      .expect(200);
  });

  describe('S01 AS-27: revoked session', () => {
    it('is refused at once by a sensitive route and accepted by an ordinary one until exp', async () => {
      const user = await t.seedUser();
      const session = await loginAs(user.email!);
      const auth = bearer(session.accessToken.token);

      await t.http().post('/api/probe/sensitive').set(auth).expect(201);
      await t.http().post('/api/auth/logout').set(auth).expect(204);

      const refused = await t
        .http()
        .post('/api/probe/sensitive')
        .set(auth)
        .expect(401);
      expect(problemDetailsSchema.parse(refused.body).code).toBe(
        'invalid_token',
      );
      await t.http().get('/api/probe/ordinary').set(auth).expect(200); // the documented staleness bound

      t.clock.advance(306_000); // past exp (300 s) plus the 5 s tolerance
      await t.http().get('/api/probe/ordinary').set(auth).expect(401);
    });

    it('fails closed when the revocation store cannot be read', async () => {
      const user = await t.seedUser();
      const session = await loginAs(user.email!);
      jest
        .spyOn(RevocationMarkers.prototype, 'isRevoked')
        .mockRejectedValue(new Error('redis down'));

      const res = await t
        .http()
        .post('/api/probe/sensitive')
        .set(bearer(session.accessToken.token))
        .expect(503);
      expect(res.body.user).toBeUndefined();
      await t
        .http()
        .get('/api/probe/ordinary')
        .set(bearer(session.accessToken.token))
        .expect(200);
    });
  });

  it('S01 AS-28: a role change shows in the access token only after a refresh', async () => {
    const user = await t.seedUser();
    const session = await loginAs(user.email!);
    await userModel.update({ role: Role.ADMIN }, { where: { id: user.id } });

    const old = await t
      .http()
      .get('/api/probe/ordinary')
      .set(bearer(session.accessToken.token))
      .expect(200);
    expect(old.body.user.role).toBe('USER');
    await t
      .http()
      .get('/api/probe/admin')
      .set(bearer(session.accessToken.token))
      .expect(403);

    const refreshed = authSessionSchema.parse(
      (
        await t
          .http()
          .post('/api/auth/refresh')
          .send({ refreshToken: session.refreshToken })
          .expect(200)
      ).body,
    );
    const fresh = await t
      .http()
      .get('/api/probe/admin')
      .set(bearer(refreshed.accessToken.token))
      .expect(200);
    expect(fresh.body.user.role).toBe('ADMIN');
  });

  it.each([
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/logout-all'],
    ['GET', '/api/auth/sessions'],
    ['GET', '/api/auth/me'],
    ['POST', '/api/auth/mfa/enroll'],
    ['POST', '/api/auth/mfa/confirm'],
  ] as const)(
    'S01 AS-29: %s %s without credentials is 401 invalid_token',
    async (method, path) => {
      const res = await t
        .http()
        [method === 'GET' ? 'get' : 'post'](path)
        .expect(401);
      expect(problemDetailsSchema.parse(res.body).code).toBe('invalid_token');
    },
  );

  describe('S01 AS-30: authentication and throttling run before validation', () => {
    it('no token and an invalid body is 401, not 400', async () => {
      await t
        .http()
        .post('/api/auth/mfa/confirm')
        .send({ code: 1234567890, unknown: true })
        .expect(401);
    });

    it('an address over the login limit with an invalid body is 429, not 400', async () => {
      for (let i = 0; i < 20; i++)
        await t
          .http()
          .post('/api/auth/login')
          .send({
            email: `order-${i}@example.com`,
            password: 'wrong password!',
          })
          .expect(401);
      await t
        .http()
        .post('/api/auth/login')
        .send({ email: 'order-x@example.com' })
        .expect(429);
    });
  });

  it('S01 AS-57: credential responses are not cacheable', async () => {
    const user = await t.seedUser();
    const login = await t
      .http()
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);
    const refresh = await t
      .http()
      .post('/api/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(200);
    for (const res of [login, refresh]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['pragma']).toBe('no-cache');
    }
  });
});
