import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import {
  acceptedSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import {
  memoryMailbox,
  TransactionalMailModule,
} from '@app/domains/notifications';
import { AuthTestApp, createAuthApp, TEST_PASSWORD } from './testing/auth-app';
import { flushRedis, passwordLogin } from './testing/mfa-fixtures';

const NEW_PASSWORD = 'a brand new passphrase 42';
const REQUEST_SPECIFIC = new Set([
  'date',
  'x-request-id',
  'request-id',
  'ratelimit',
  'ratelimit-policy',
  'traceparent',
  'content-length',
  'connection',
  'keep-alive',
]);
const stableHeaders = (headers: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(headers).filter(([name]) => !REQUEST_SPECIFIC.has(name)),
  );

describe('Password reset', () => {
  let t: AuthTestApp;
  let sql: Sequelize;
  let counter = 0;
  const savedProvider = process.env.EMAIL_PROVIDER;

  beforeAll(async () => {
    process.env.EMAIL_PROVIDER = 'memory';
    t = await createAuthApp({
      extraImports: [TransactionalMailModule],
      manualRateTime: true,
    });
    sql = t.app.get(Sequelize);
  });
  afterAll(async () => {
    await t.close();
    if (savedProvider === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = savedProvider;
  });
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
    memoryMailbox.clear();
    jest.restoreAllMocks();
  });

  const request = (email: string) =>
    t.http().post('/api/auth/password-reset/request').send({ email });
  const confirm = (body: Record<string, unknown>) =>
    t.http().post('/api/auth/password-reset/confirm').send(body);
  const newUser = async () => {
    const email = `reset-${++counter}-${Date.now()}@example.com`;
    const user = await t.seedUser({ email });
    return { user, email };
  };
  /** The token of the newest reset mail to `email` (polls: the mail is sent after the answer). */
  async function tokenFor(email: string): Promise<string> {
    const until = Date.now() + 3_000;
    for (;;) {
      const [message] = memoryMailbox.list(email);
      const link = message?.links.find((l) => l.includes('#token='));
      if (link) return link.split('#token=')[1];
      if (Date.now() > until) throw new Error(`no reset mail for ${email}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('password-reset: request answers 202 accepted with identical body and headers for a known and an unknown address', async () => {
    const { email } = await newUser();
    const known = await request(email).expect(202);
    const unknown = await request('nobody-here@example.com').expect(202);
    expect(acceptedSchema.parse(known.body)).toEqual({ status: 'accepted' });
    expect(unknown.body).toEqual(known.body);
    expect(stableHeaders(unknown.headers)).toEqual(
      stableHeaders(known.headers),
    );
    expect(known.headers['set-cookie']).toBeUndefined();
  });

  it('password-reset: the mail is sent only for the known address and carries the fragment link', async () => {
    const { email } = await newUser();
    await request('nobody-here@example.com').expect(202);
    await request(email).expect(202);
    const token = await tokenFor(email);
    const site = t.app.get(ApiConfigService).get('front_host');
    expect(memoryMailbox.list(email)[0].links).toEqual([
      `${site}/reset-password#token=${token}`,
    ]);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(memoryMailbox.list('nobody-here@example.com')).toEqual([]);
  });

  it('password-reset: confirm sets the new password, the old one stops working and every session of the user ends', async () => {
    const { email } = await newUser();
    const { accessToken } = await passwordLogin(t, email);
    await t
      .http()
      .get('/api/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await request(email).expect(202);
    const token = await tokenFor(email);
    const res = await confirm({ token, password: NEW_PASSWORD }).expect(204);
    expect(res.headers['cache-control']).toBe('no-store');

    await t
      .http()
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(401);
    await passwordLogin(t, email, NEW_PASSWORD);
    await t
      .http()
      .get('/api/auth/mfa')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  it.each([
    ['reused', async () => undefined],
    ['expired', async (t_: AuthTestApp) => t_.clock.advance(31 * 60_000)],
  ])(
    'password-reset: a %s token is 400 invalid_reset_token',
    async (kind, afterwards) => {
      const { email } = await newUser();
      await request(email).expect(202);
      const token = await tokenFor(email);
      if (kind === 'reused')
        await confirm({ token, password: NEW_PASSWORD }).expect(204);
      await afterwards(t);
      const res = await confirm({
        token,
        password: 'yet another passphrase 7',
      }).expect(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'invalid_reset_token',
      );
    },
  );

  it('password-reset: an unknown token is 400 invalid_reset_token', async () => {
    const res = await confirm({
      token: 'x'.repeat(43),
      password: NEW_PASSWORD,
    }).expect(400);
    expect(problemDetailsSchema.parse(res.body).code).toBe(
      'invalid_reset_token',
    );
  });

  it('password-reset: a breached password is 422 weak_password and the token stays valid', async () => {
    const { email } = await newUser();
    await request(email).expect(202);
    const token = await tokenFor(email);
    t.breach.breached.add('a breached passphrase 1');
    const weak = await confirm({
      token,
      password: 'a breached passphrase 1',
    }).expect(422);
    expect(problemDetailsSchema.parse(weak.body).code).toBe('weak_password');
    await confirm({ token, password: NEW_PASSWORD }).expect(204);
  });

  it('password-reset: a second request invalidates the first link', async () => {
    const { email } = await newUser();
    await request(email).expect(202);
    const first = await tokenFor(email);
    memoryMailbox.clear();
    await request(email).expect(202);
    const second = await tokenFor(email);
    expect(second).not.toBe(first);
    const old = await confirm({ token: first, password: NEW_PASSWORD }).expect(
      400,
    );
    expect(old.body.code).toBe('invalid_reset_token');
    await confirm({ token: second, password: NEW_PASSWORD }).expect(204);
  });

  it('password-reset: validation_failed lists field and code pairs for email and password on register and on confirm', async () => {
    const register = await t
      .http()
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'short' })
      .expect(400);
    const regProblem = problemDetailsSchema.parse(register.body);
    expect(regProblem.code).toBe('validation_failed');
    expect(regProblem.errors?.map((e) => e.field).sort()).toEqual([
      'email',
      'password',
    ]);
    for (const e of regProblem.errors ?? [])
      expect(e).toEqual({ field: e.field, code: expect.any(String) });

    const confirmed = await confirm({ token: 't', password: 'short' }).expect(
      400,
    );
    const confirmProblem = problemDetailsSchema.parse(confirmed.body);
    expect(confirmProblem.code).toBe('validation_failed');
    expect(confirmProblem.errors?.map((e) => e.field)).toContain('password');

    const requested = await request('nope').expect(400);
    expect(
      problemDetailsSchema.parse(requested.body).errors?.map((e) => e.field),
    ).toContain('email');
  });

  it('password-reset: the request route is 429 after 5 requests from one address and confirm after 10', async () => {
    for (let i = 0; i < 5; i++)
      await request(`limit-${i}@example.com`).expect(202);
    const limited = await request('limit-6@example.com').expect(429);
    expect(limited.headers['retry-after']).toBeDefined();

    for (let i = 0; i < 10; i++)
      await confirm({ token: `bad-${i}`, password: NEW_PASSWORD }).expect(400);
    const confirmLimited = await confirm({
      token: 'bad-11',
      password: NEW_PASSWORD,
    }).expect(429);
    expect(confirmLimited.headers['retry-after']).toBeDefined();
  });

  it('password-reset: more than 3 requests for one address in an hour are 429 for known and unknown addresses alike', async () => {
    const { email } = await newUser();
    for (let i = 0; i < 3; i++) await request(email).expect(202);
    await request(email).expect(429);
    // The per-address window is the subject here, not the per-IP one. The sliding window weighs the previous hour's
    // count, so two full windows must pass before the IP's earlier requests stop counting.
    t.rateTime.advance(2 * 3_600_000 + 1);
    for (let i = 0; i < 3; i++) await request('ghost@example.com').expect(202);
    await request('ghost@example.com').expect(429);
  });

  it('password-reset: the raw token is in no table, outbox row or log line', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation(
          (...args: unknown[]) => void lines.push(String(args)),
        );
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });

    const { email, user } = await newUser();
    await request(email).expect(202);
    const token = await tokenFor(email);
    await confirm({ token, password: NEW_PASSWORD }).expect(204);
    stdout.mockRestore();

    const rows = await sql.query(
      `SELECT * FROM "PasswordResetToken" WHERE "userId" = $1`,
      { bind: [user.id], type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
    const outbox = await sql.query(`SELECT * FROM "Outbox"`, {
      type: QueryTypes.SELECT,
    });
    const everything = JSON.stringify([rows, outbox, lines]);
    expect(everything).not.toContain(token);
    expect((rows[0] as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
