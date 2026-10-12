import { createPublicKey } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import {
  jwksSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { AuthTestApp, createAuthApp, decodeJwt } from './testing/auth-app';
import { ServiceProbeModule } from './testing/probe.module';
import { ServiceTokenService } from './application/service-token.service';
import { SessionIssuer } from './application/session-issuer.service';
import { SessionRevocationService } from './application/session-revocation.service';
import { KeyStore } from './infra/keys/key-store.service';

describe('Service tokens', () => {
  let t: AuthTestApp;
  let tokens: ServiceTokenService;

  beforeAll(async () => {
    t = await createAuthApp({ extraImports: [ServiceProbeModule] });
    tokens = t.app.get(ServiceTokenService, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  const internal = (token?: string) =>
    t
      .http()
      .get('/api/probe/internal')
      .set(token ? { Authorization: `Bearer ${token}` } : {});
  const sign = (
    claims: object,
    options: { audience: string; typ: string; expiresInSec: number },
  ) => t.app.get(KeyStore).sign(claims, options);
  const userSession = async () => {
    const user = await t.seedUser();
    return t.app.get(SessionIssuer).issue({ userId: user.id, amr: ['pwd'] });
  };

  it('S01 AS-68: a minted token has the service profile and verifies from the JWKS', async () => {
    const token = await tokens.mint({ caller: 'worker', audience: 'core' });

    const { header, claims } = decodeJwt(token);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'svc+jwt' });
    expect(claims).toMatchObject({
      iss: 'marketplace',
      sub: 'svc:worker',
      aud: 'core',
      jti: expect.any(String),
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    for (const forbidden of ['role', 'sid', 'email', 'act'])
      expect(claims).not.toHaveProperty(forbidden);
    const jwks = jwksSchema.parse(
      (await t.http().get('/.well-known/jwks.json').expect(200)).body,
    );
    const jwk = jwks.keys.find((k) => k.kid === header.kid)!;
    expect(() =>
      jwt.verify(token, createPublicKey({ key: jwk, format: 'jwk' }), {
        algorithms: ['ES256'],
        issuer: 'marketplace',
        audience: 'core',
      }),
    ).not.toThrow();
    const other = decodeJwt(
      await tokens.mint({ caller: 'worker', audience: 'worker' }),
    ).claims;
    expect(other.jti).not.toBe(claims.jti);
  });

  it('S01 AS-68: a request outside the policy is refused and mints nothing', async () => {
    await expect(
      tokens.mint({ caller: 'worker', audience: 'billing-api' }),
    ).rejects.toThrow();
    await expect(
      tokens.mint({ caller: 'worker', audience: 'core', ttlSec: 301 }),
    ).rejects.toThrow();
    await expect(
      tokens.mint({ caller: '', audience: 'core' }),
    ).rejects.toThrow();
  });

  describe('S01 AS-69: internal endpoint for audience core, callers worker and billing', () => {
    it('answers 200 with the service principal for a valid token of an allowed caller', async () => {
      const token = await tokens.mint({ caller: 'worker', audience: 'core' });

      const res = await internal(token).expect(200);

      expect(res.body).toEqual({ user: { kind: 'service', caller: 'worker' } });
    });

    it('answers 401 for a token minted for another audience', async () => {
      const token = await sign(
        { sub: 'svc:worker' },
        { audience: 'billing-api', typ: 'svc+jwt', expiresInSec: 60 },
      );
      const res = await internal(token).expect(401);
      expect(problemDetailsSchema.parse(res.body).code).toBe('invalid_token');
    });

    it('answers 403 service_caller_not_allowed for a valid token of a caller outside the allowlist', async () => {
      const token = await tokens.mint({
        caller: 'projector',
        audience: 'core',
      });

      const res = await internal(token).expect(403);

      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'service_caller_not_allowed',
      );
    });

    it('answers 401 for an expired token', async () => {
      const token = await sign(
        { sub: 'svc:worker' },
        { audience: 'core', typ: 'svc+jwt', expiresInSec: -60 },
      );
      await internal(token).expect(401);
    });

    it('answers 401 for a user access token and for no token', async () => {
      const session = await userSession();
      await internal(session.accessToken.token).expect(401);
      await internal().expect(401);
    });

    it('answers 401 for a service token on a user route, and for a service subject without the svc: prefix', async () => {
      const token = await tokens.mint({ caller: 'worker', audience: 'core' });
      await t
        .http()
        .get('/api/auth/me')
        .set({ Authorization: `Bearer ${token}` })
        .expect(401);
      const forged = await sign(
        { sub: 'worker' },
        { audience: 'core', typ: 'svc+jwt', expiresInSec: 60 },
      );
      await internal(forged).expect(401);
    });
  });

  describe('S01 AS-70: on-behalf-of exchange', () => {
    it('turns a live user access token into a service token that names the user and the caller', async () => {
      const session = await userSession();

      const token = await tokens.exchange({
        userAccessToken: session.accessToken.token,
        caller: 'core',
        audience: 'worker',
      });

      const { claims, header } = decodeJwt(token);
      expect(header).toMatchObject({ typ: 'svc+jwt', alg: 'ES256' });
      expect(claims).toMatchObject({
        sub: session.user.id,
        act: { sub: 'svc:core' },
        sid: session.sessionId,
        aud: 'worker',
      });
      expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    });

    it('is seen by the endpoint as the caller acting for the user', async () => {
      const session = await userSession();
      const token = await tokens.exchange({
        userAccessToken: session.accessToken.token,
        caller: 'worker',
        audience: 'core',
      });

      const res = await internal(token).expect(200);

      expect(res.body.user).toEqual({
        kind: 'service',
        caller: 'worker',
        onBehalfOf: { userId: session.user.id, sessionId: session.sessionId },
      });
    });

    it('refuses a revoked session and a token that is not a user access token', async () => {
      const session = await userSession();
      await t.app
        .get(SessionRevocationService)
        .revokeBySid(session.sessionId, 'logout');

      await expect(
        tokens.exchange({
          userAccessToken: session.accessToken.token,
          caller: 'core',
          audience: 'worker',
        }),
      ).rejects.toThrow();
      await expect(
        tokens.exchange({
          userAccessToken: await tokens.mint({
            caller: 'core',
            audience: 'worker',
          }),
          caller: 'core',
          audience: 'worker',
        }),
      ).rejects.toThrow();
    });
  });
});
