import { ApiConfigService } from '@app/common/config/api-config.service';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { getModelToken } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import * as bcrypt from 'bcrypt';
import { generate } from 'otplib';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import User from './infra/models/user.model';
import SigningKey from './infra/models/signing-key.model';
import { AuthApiModule } from './auth-api.module';
import { AuthService } from './application/auth.service';
import { KeyStore } from './infra/keys/key-store.service';
import { SecretBox } from './infra/crypto/secret-box';

/**
 * SD-39 against real Postgres + DynamoDB Local + Redis: session tokens,
 * refresh rotation + reuse detection, revocation, bcrypt→argon2 migration,
 * key rotation, MFA, legacy-token compatibility.
 */
describe('Auth sessions (e2e)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let userModel: typeof User;
  let keyModel: typeof SigningKey;

  const http = () => request(app.getHttpServer());
  const password = 'correct horse battery';

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([AuthApiModule, RateLimitModule, CacheModule, SeedsModule], { stores: ['redis', 'dynamo'] });
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['.well-known/jwks.json'] });
    await app.init();
    seedsService = app.get(SeedsService);
    userModel = app.get(getModelToken(User));
    keyModel = app.get(getModelToken(SigningKey));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
    await keyModel.destroy({ where: {} });
    app.get(KeyStore).invalidate();
  });

  const register = async (email = `u-${v4()}@mail.com`) => (await http().post('/api/auth/register').send({ email, password }).expect(201)).body;

  it('register → ES256 access token with kid + session id; works on protected routes', async () => {
    const session = await register();
    const [header] = session.accessToken.token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'ES256' });
    expect(session.sessionId).toBeDefined();

    await http().get('/api/auth/me').set('Authorization', `Bearer ${session.accessToken.token}`).expect(200);

    const jwks = await http().get('/.well-known/jwks.json').expect(200);
    expect(jwks.body.keys.map((k: { kid: string }) => k.kid)).toContain(JSON.parse(Buffer.from(header, 'base64url').toString()).kid);
    expect(jwks.body.keys.every((k: { d?: string }) => k.d === undefined)).toBe(true); // never leak private parts
  });

  it('refresh rotates the token; replaying the old one revokes the whole session', async () => {
    (app.get(ApiConfigService) as MockApiConfigService).set('auth_refresh_reuse_grace_ms', 0); // every replay counts as theft
    const session = await register();

    const rotated = (await http().post('/api/auth/refresh').send({ refreshToken: session.refreshToken }).expect(200)).body;
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    // Attacker replays the stolen (already used) token.
    await http().post('/api/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);

    // The legitimate holder's newer token is dead too: the family was revoked.
    await http().post('/api/auth/refresh').send({ refreshToken: rotated.refreshToken }).expect(401);
  });

  it('a replay within the grace window (dropped response, two tabs) gets a fresh token instead of a revocation', async () => {
    (app.get(ApiConfigService) as MockApiConfigService).set('auth_refresh_reuse_grace_ms', 10_000);
    const session = await register();

    const first = (await http().post('/api/auth/refresh').send({ refreshToken: session.refreshToken }).expect(200)).body;
    const replay = (await http().post('/api/auth/refresh').send({ refreshToken: session.refreshToken }).expect(200)).body;
    expect(replay.refreshToken).not.toBe(first.refreshToken);
    // Both successors stay usable: nothing was revoked.
    await http().post('/api/auth/refresh').send({ refreshToken: first.refreshToken }).expect(200);
    await http().post('/api/auth/refresh').send({ refreshToken: replay.refreshToken }).expect(200);
  });

  it('logout-all revokes sessions; sensitive endpoints reject the still-unexpired access token immediately', async () => {
    const email = `u-${v4()}@mail.com`;
    const a = await register(email);
    const b = (await http().post('/api/auth/login').send({ email, password }).expect(200)).body;

    await http().post('/api/auth/logout-all').set('Authorization', `Bearer ${b.accessToken.token}`).expect(201);

    await http().post('/api/auth/mfa/enroll').set('Authorization', `Bearer ${a.accessToken.token}`).expect(401);
    await http().post('/api/auth/refresh').send({ refreshToken: a.refreshToken }).expect(401);
  });

  it('legacy bcrypt hashes still log in and are upgraded to argon2id on the way', async () => {
    const email = `legacy-${v4()}@mail.com`;
    await userModel.create({ email, passwordHash: await bcrypt.hash(password, 10) });

    await http().post('/api/auth/login').send({ email, password }).expect(200);

    const user = await userModel.findOne({ where: { email } });
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    await http().post('/api/auth/login').send({ email, password }).expect(200);
  });

  it('wrong password and unknown email give the same 401 (no user enumeration)', async () => {
    const { user } = await register();
    const wrong = await http().post('/api/auth/login').send({ email: user.email, password: 'nope-nope-nope' }).expect(401);
    const unknown = await http().post('/api/auth/login').send({ email: `ghost-${v4()}@mail.com`, password }).expect(401);
    expect(wrong.body.detail).toBe(unknown.body.detail);
  });

  it('key rotation: tokens signed by the previous key stay valid while it is RETIRED but published', async () => {
    const session = await register();
    const store = app.get(KeyStore);
    const [oldKey] = await keyModel.findAll({ where: { status: 'ACTIVE' } });

    const nextKid = await store.createKey('NEXT');
    await oldKey.update({ status: 'RETIRED', retiredAt: new Date() });
    await keyModel.update({ status: 'ACTIVE', activatedAt: new Date() }, { where: { kid: nextKid } });
    store.invalidate();

    await http().get('/api/auth/me').set('Authorization', `Bearer ${session.accessToken.token}`).expect(200);
    const fresh = (await http().post('/api/auth/refresh').send({ refreshToken: session.refreshToken }).expect(200)).body;
    expect(JSON.parse(Buffer.from(fresh.accessToken.token.split('.')[0], 'base64url').toString()).kid).toBe(nextKid);
  });

  it('MFA: login returns a challenge; the TOTP code completes it; the same code cannot be replayed', async () => {
    const email = `mfa-${v4()}@mail.com`;
    const session = await register(email);
    const auth = { Authorization: `Bearer ${session.accessToken.token}` };

    await http().post('/api/auth/mfa/enroll').set(auth).expect(201);
    const user = await userModel.findOne({ where: { email } });
    const secret = app.get(SecretBox).open(user!.mfaSecretEnc!);

    const confirmCode = await generate({ secret });
    const { recoveryCodes } = (await http().post('/api/auth/mfa/confirm').set(auth).send({ code: confirmCode }).expect(201)).body;
    expect(recoveryCodes).toHaveLength(10);

    const challenge = (await http().post('/api/auth/login').send({ email, password }).expect(200)).body;
    expect(challenge).toMatchObject({ mfaRequired: true });
    // The challenge token is not an access token.
    await http().get('/api/auth/me').set('Authorization', `Bearer ${challenge.mfaToken}`).expect(401);

    // Same code as confirm → replay rejected; a recovery code works once.
    await http().post('/api/auth/mfa/verify').send({ mfaToken: challenge.mfaToken, code: confirmCode }).expect(401);
    await http().post('/api/auth/mfa/verify').send({ mfaToken: challenge.mfaToken, code: recoveryCodes[0] }).expect(200);
    await http().post('/api/auth/mfa/verify').send({ mfaToken: challenge.mfaToken, code: recoveryCodes[0] }).expect(401);
  });

  it('legacy RS256 tokens (no kid) keep working during the migration', async () => {
    const [user] = await seedsService.createTreelike([{ __type__: TableName.User, email: `old-${v4()}@mail.com` }]);
    const legacy = app.get(AuthService).issueTokensFor(user).accessToken.token;
    await http().get('/api/auth/me').set('Authorization', `Bearer ${legacy}`).expect(200);
  });
});
