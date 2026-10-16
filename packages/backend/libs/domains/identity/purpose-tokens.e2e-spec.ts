import { v4 } from 'uuid';
import { AuthTestApp, createAuthApp, decodeJwt } from './testing/auth-app';
import {
  InvalidPurposeTokenError,
  PurposeTokenService,
} from './application/purpose-token.service';
import { TokenAuthService } from './application/token-auth.service';
import { KeyStore } from './infra/keys/key-store.service';

jest.setTimeout(180_000);

describe('Purpose tokens (S22 Requires S01 R1)', () => {
  let t: AuthTestApp;
  let purpose: PurposeTokenService;

  beforeAll(async () => {
    t = await createAuthApp();
    purpose = t.app.get(PurposeTokenService, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
  });

  it('S01 purpose token: ES256, issuer marketplace, its own typ, audience, subject, jti, lifetime', async () => {
    const subject = v4();
    const jti = v4();
    const token = await purpose.sign({
      subject,
      audience: 'admission:evt',
      ttlSec: 600,
      jti,
      claims: { purpose: 'admission' },
    });
    const { header, claims } = decodeJwt(token);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'purpose+jwt' });
    expect(claims).toMatchObject({
      iss: 'marketplace',
      aud: 'admission:evt',
      sub: subject,
      jti,
      purpose: 'admission',
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(600);

    await expect(
      purpose.verify(token, { audience: 'admission:evt', subject }),
    ).resolves.toMatchObject({
      subject,
      jti,
      claims: { purpose: 'admission' },
    });
  });

  it.each([
    ['another audience', { audience: 'admission:other' }],
    ['another subject', { audience: 'admission:evt', subject: v4() }],
  ])('S01 purpose token: refused for %s', async (_name, expected) => {
    const subject = v4();
    const token = await purpose.sign({
      subject,
      audience: 'admission:evt',
      ttlSec: 60,
    });
    await expect(purpose.verify(token, expected)).rejects.toBeInstanceOf(
      InvalidPurposeTokenError,
    );
  });

  it('S01 purpose token: refused after expiry, as garbage, and as an access token (and the reverse)', async () => {
    const subject = v4();
    const token = await purpose.sign({
      subject,
      audience: 'admission:evt',
      ttlSec: 60,
    });
    t.clock.advance(61_000 + 5_000);
    await expect(
      purpose.verify(token, { audience: 'admission:evt', subject }),
    ).rejects.toBeInstanceOf(InvalidPurposeTokenError);
    await expect(
      purpose.verify('not-a-token', { audience: 'admission:evt' }),
    ).rejects.toBeInstanceOf(InvalidPurposeTokenError);

    const fresh = await purpose.sign({
      subject,
      audience: 'admission:evt',
      ttlSec: 60,
    });
    await expect(
      t.app.get(TokenAuthService).authenticate(fresh),
    ).rejects.toBeDefined();

    const access = await t.app
      .get(KeyStore)
      .sign(
        { sub: subject, sid: v4(), role: 'USER', amr: [] },
        { audience: 'marketplace-api', typ: 'at+jwt', expiresInSec: 60 },
      );
    await expect(
      purpose.verify(access, { audience: 'marketplace-api' }),
    ).rejects.toBeInstanceOf(InvalidPurposeTokenError);
  });
});
