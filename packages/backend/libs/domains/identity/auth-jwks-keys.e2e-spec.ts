import { createPrivateKey, createPublicKey } from 'node:crypto';
import { getModelToken } from '@nestjs/sequelize';
import * as jwt from 'jsonwebtoken';
import { jwksSchema } from '@marketplace-sandbox/contracts';
import { AuthTestApp, createAuthApp, decodeJwt } from './testing/auth-app';
import { SessionIssuer } from './application/session-issuer.service';
import { KeyRotationService } from './application/key-rotation.service';
import { SecretBox } from './infra/crypto/secret-box';
import SigningKey from './infra/models/signing-key.model';
import { KeyStore } from './infra/keys/key-store.service';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('JWKS and signing keys', () => {
  let t: AuthTestApp;
  let keys: typeof SigningKey;
  let rotation: KeyRotationService;
  let issuer: SessionIssuer;

  beforeAll(async () => {
    t = await createAuthApp();
    keys = t.app.get(getModelToken(SigningKey));
    rotation = t.app.get(KeyRotationService);
    issuer = t.app.get(SessionIssuer);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await keys.destroy({ where: {} });
    t.app.get(KeyStore).invalidate();
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const rows = async () => (await keys.findAll({ raw: true })) as SigningKey[];
  const byStatus = async (status: string) =>
    (await rows()).filter((k) => k.status === status);
  const login = async () => {
    const user = await t.seedUser();
    return issuer.issue({ userId: user.id, amr: ['pwd'] });
  };
  const me = (token: string) => t.http().get('/api/auth/me').set(bearer(token));
  /** Moves a key back in time instead of waiting: the rotation rules compare these stamps with the clock. */
  const backdate = (kid: string, patch: Record<string, Date>) =>
    keys.update(patch, { where: { kid } });
  const ago = (ms: number) => new Date(t.clock.nowMs() - ms);

  /** ACTIVE (from a login) + NEXT, with ACTIVE old enough and NEXT published long enough to promote. */
  async function dueForPromotion() {
    const first = await login();
    await rotation.run(); // creates NEXT
    const [active] = await byStatus('ACTIVE');
    const [next] = await byStatus('NEXT');
    await backdate(active.kid, {
      activatedAt: ago(8 * DAY),
      createdAt: ago(9 * DAY),
    });
    await backdate(next.kid, { createdAt: ago(25 * HOUR) });
    return { first, active, next };
  }

  it('S01 AS-58: the JWKS lists every key with public members only, with caching headers and ETag/304', async () => {
    const { active, next } = await dueForPromotion();
    await rotation.run(); // promote: ACTIVE -> RETIRED, NEXT -> ACTIVE, new NEXT

    const res = await t.http().get('/.well-known/jwks.json').expect(200);

    const body = jwksSchema.parse(res.body);
    expect(body.keys).toHaveLength(3);
    expect(body.keys.map((k) => k.kid).sort()).toEqual(
      (await rows()).map((k) => k.kid).sort(),
    );
    expect(body.keys.map((k) => k.kid)).toEqual(
      expect.arrayContaining([active.kid, next.kid]),
    );
    for (const key of res.body.keys)
      expect(Object.keys(key).sort()).toEqual(
        ['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y'].sort(),
      );
    expect(res.headers['cache-control']).toBe(
      'public, max-age=300, stale-while-revalidate=3600',
    );
    const etag = res.headers['etag'];
    expect(etag).toEqual(expect.any(String));
    await t
      .http()
      .get('/.well-known/jwks.json')
      .set('If-None-Match', etag)
      .expect(304);
    // A different key set has a different tag.
    await rotation.run();
    await keys.destroy({ where: { status: 'NEXT' } });
    t.app.get(KeyStore).invalidate();
    const changed = await t.http().get('/.well-known/jwks.json').expect(200);
    expect(changed.headers['etag']).not.toBe(etag);
  });

  it('S01 AS-59: a stock verifier configured only from the JWKS verifies a login token', async () => {
    const session = await login();
    const jwks = jwksSchema.parse(
      (await t.http().get('/.well-known/jwks.json').expect(200)).body,
    );
    const { header } = decodeJwt(session.accessToken.token);
    const jwk = jwks.keys.find((k) => k.kid === header.kid)!;

    const claims = jwt.verify(
      session.accessToken.token,
      createPublicKey({ key: jwk, format: 'jwk' }),
      {
        algorithms: ['ES256'],
        issuer: 'marketplace',
        audience: 'marketplace-api',
      },
    ) as jwt.JwtPayload;

    expect(claims.sub).toBe(session.user.id);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
  });

  it('S01 AS-60: ten concurrent first uses create exactly one ACTIVE key and all tokens carry it', async () => {
    const user = await t.seedUser();

    const sessions = await Promise.all(
      Array.from({ length: 10 }, () =>
        issuer.issue({ userId: user.id, amr: ['pwd'] }),
      ),
    );

    const active = await byStatus('ACTIVE');
    expect(active).toHaveLength(1);
    expect(
      new Set(sessions.map((s) => decodeJwt(s.accessToken.token).header.kid)),
    ).toEqual(new Set([active[0].kid]));
  });

  it('S01 AS-61: rotation promotes NEXT, retires ACTIVE, creates a new NEXT, and old tokens keep verifying', async () => {
    const { first, active, next } = await dueForPromotion();
    await me(first.accessToken.token).expect(200);

    await rotation.run();

    expect((await byStatus('ACTIVE')).map((k) => k.kid)).toEqual([next.kid]);
    const [retired] = await byStatus('RETIRED');
    expect(retired.kid).toBe(active.kid);
    expect(retired.retiredAt).toEqual(expect.any(Date));
    const [fresh] = await byStatus('NEXT');
    expect(fresh.kid).not.toBe(next.kid);
    await me(first.accessToken.token).expect(200);
    const second = await login();
    expect(decodeJwt(second.accessToken.token).header.kid).toBe(next.kid);
    await me(second.accessToken.token).expect(200);
  });

  it('S01 AS-63: a RETIRED key is purged 24 h after retirement and its tokens stop verifying; a younger one is kept', async () => {
    const { first, active } = await dueForPromotion();
    await rotation.run(); // active is now RETIRED
    await backdate(active.kid, { retiredAt: ago(23 * HOUR) });
    await rotation.run();
    expect((await byStatus('RETIRED')).map((k) => k.kid)).toEqual([active.kid]);
    await me(first.accessToken.token).expect(200);

    await backdate(active.kid, { retiredAt: ago(25 * HOUR) });
    await rotation.run();

    expect(await byStatus('RETIRED')).toHaveLength(0);
    const jwks = (await t.http().get('/.well-known/jwks.json').expect(200))
      .body;
    expect(jwks.keys.map((k: { kid: string }) => k.kid)).not.toContain(
      active.kid,
    );
    await me(first.accessToken.token).expect(401);
  });

  it('S01 AS-64: concurrent and repeated rotation runs leave one ACTIVE and one NEXT and the third changes nothing', async () => {
    await dueForPromotion();

    const results = await Promise.allSettled([rotation.run(), rotation.run()]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await byStatus('ACTIVE')).toHaveLength(1);
    expect(await byStatus('NEXT')).toHaveLength(1);
    const before = (await rows()).map((k) => `${k.kid}:${k.status}`).sort();
    await rotation.run();
    expect((await rows()).map((k) => `${k.kid}:${k.status}`).sort()).toEqual(
      before,
    );
  });

  it('S01 AS-64: from an empty store, two simultaneous runs end with one ACTIVE and one NEXT', async () => {
    const results = await Promise.allSettled([rotation.run(), rotation.run()]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await byStatus('ACTIVE')).toHaveLength(1);
    expect(await byStatus('NEXT')).toHaveLength(1);
  });

  it('S01 AS-66: the stored private key is sealed: unreadable, bound to its kid, not openable with another master key', async () => {
    await login();
    const [row] = await byStatus('ACTIVE');
    const sealed = row.privateKeyEnc;

    expect(sealed).not.toContain('PRIVATE KEY');
    expect(() => createPrivateKey(sealed)).toThrow();
    const box = t.app.get(SecretBox);
    expect(box.open(sealed, `signing-key:${row.kid}`)).toContain('PRIVATE KEY');
    expect(() => box.open(sealed, 'signing-key:other')).toThrow();
    expect(() => box.open(sealed)).toThrow();
    const other = new SecretBox({
      get: (key: string) =>
        key === 'auth_kek'
          ? Buffer.alloc(32, 9).toString('base64')
          : key === 'node_env'
            ? 'test'
            : undefined,
    } as never);
    expect(() => other.open(sealed, `signing-key:${row.kid}`)).toThrow();
  });
});
