import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  memoryMailbox,
  TransactionalMailModule,
} from '@app/domains/notifications';
import {
  authStore,
  AuthTestApp,
  createAuthApp,
  decodeJwt,
  TEST_PASSWORD,
} from './testing/auth-app';
import { flushRedis, passwordLogin } from './testing/mfa-fixtures';
import { ResetTokenMaintenanceService } from './application/reset-token-maintenance.service';
import {
  RESET_TOKEN_REPOSITORY,
  type ResetTokenRepository,
} from './domain/ports';

const NEW_PASSWORD = 'a brand new passphrase 42';

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
  const member = async (input: { passwordHash?: null } = {}) => {
    const email = `reset-${++counter}-${Date.now()}@example.com`;
    return { user: await t.seedUser({ email, ...input }), email };
  };
  /** The token of the newest reset mail to `email` (polls: the mail is sent after the answer). */
  async function tokenFor(email: string): Promise<string> {
    const until = Date.now() + 3_000;
    for (;;) {
      const link = memoryMailbox
        .list(email)
        .flatMap((m) => m.links)
        .find((l) => l.includes('#token='));
      if (link) return link.split('#token=')[1];
      if (Date.now() > until) throw new Error(`no reset mail for ${email}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const quiet = () => new Promise((r) => setTimeout(r, 300));
  const codeOf = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body).code;

  it('S01 AS-73: the request is a uniform 202 for an existing, a passwordless and an unknown address; one mail, only for the existing one', async () => {
    const existing = await member();
    const passwordless = await member({ passwordHash: null });

    const answers = [
      await request(existing.email).expect(202),
      await request(passwordless.email).expect(202),
      await request('nobody-here@example.com').expect(202),
    ];

    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    expect(answers[0].body).toEqual({ status: 'accepted' });
    await tokenFor(existing.email);
    await quiet();
    expect(memoryMailbox.list(existing.email)).toHaveLength(1);
    expect(memoryMailbox.list(passwordless.email)).toEqual([]);
    expect(memoryMailbox.list('nobody-here@example.com')).toEqual([]);
  });

  it('S01 AS-73: the reset token is in no table, outbox row or log line', async () => {
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
    const { email, user } = await member();

    await request(email).expect(202);
    const token = await tokenFor(email);
    await confirm({ token, password: NEW_PASSWORD }).expect(204);
    stdout.mockRestore();

    const rows = await sql.query(
      `SELECT * FROM "PasswordResetToken" WHERE "userId" = $1`,
      { bind: [user.id], type: QueryTypes.SELECT },
    );
    const outbox = await sql.query(`SELECT * FROM "Outbox"`, {
      type: QueryTypes.SELECT,
    });
    expect(JSON.stringify([rows, outbox, lines])).not.toContain(token);
  });

  it('S01 AS-74: a newer reset token invalidates the older one', async () => {
    const { email } = await member();
    await request(email).expect(202);
    const first = await tokenFor(email);
    memoryMailbox.clear();
    await request(email).expect(202);
    const second = await tokenFor(email);
    expect(second).not.toBe(first);

    const old = await confirm({ token: first, password: NEW_PASSWORD }).expect(
      400,
    );

    expect(codeOf(old)).toBe('invalid_reset_token');
    await confirm({ token: second, password: NEW_PASSWORD }).expect(204);
  });

  it('S01 AS-75: confirm replaces the password, revokes every session with reason password_reset and records the event', async () => {
    const { email, user } = await member();
    const first = await passwordLogin(t, email);
    const second = await passwordLogin(t, email);
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
    for (const s of [first, second]) {
      await t
        .http()
        .post('/api/auth/refresh')
        .send({ refreshToken: s.body.refreshToken })
        .expect(401);
      const sid = decodeJwt(s.accessToken!).claims.sid as string;
      expect(await authStore(t.app).session(sid)).toMatchObject({
        revokeReason: 'password_reset',
      });
    }
    const events = (await outboxRowsFor(t.app, user.id)).filter(
      (r) => r.type === 'identity.password_changed',
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0].payload)).not.toContain(NEW_PASSWORD);
  });

  it.each(['unknown', 'spent', 'expired'])(
    'S01 AS-76: a %s token is a uniform 400 invalid_reset_token',
    async (kind) => {
      const { email } = await member();
      let token = 'x'.repeat(43);
      if (kind !== 'unknown') {
        await request(email).expect(202);
        token = await tokenFor(email);
      }
      if (kind === 'spent')
        await confirm({ token, password: NEW_PASSWORD }).expect(204);
      if (kind === 'expired') t.clock.advance(31 * 60_000);

      const res = await confirm({
        token,
        password: 'yet another passphrase 7',
      }).expect(400);

      expect(codeOf(res)).toBe('invalid_reset_token');
      expect(res.body.detail).toBe(
        (await confirm({ token: 'y'.repeat(43), password: NEW_PASSWORD })).body
          .detail,
      );
    },
  );

  it('S01 AS-76: a weak or breached password is 422 and keeps the token usable', async () => {
    const { email } = await member();
    await request(email).expect(202);
    const token = await tokenFor(email);
    t.breach.breached.add('a breached passphrase 1');

    const breached = await confirm({
      token,
      password: 'a breached passphrase 1',
    }).expect(422);
    const short = await confirm({ token, password: 'short' });

    expect(codeOf(breached)).toBe('weak_password');
    expect([400, 422]).toContain(short.status);
    await confirm({ token, password: NEW_PASSWORD }).expect(204);
  });

  it('S01 AS-77: two simultaneous confirms of one token have exactly one winner', async () => {
    const { email } = await member();
    await request(email).expect(202);
    const token = await tokenFor(email);

    const results = await Promise.all([
      confirm({ token, password: NEW_PASSWORD }),
      confirm({ token, password: 'another valid passphrase 9' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
    const loser = results.find((r) => r.status === 400)!;
    expect(codeOf(loser)).toBe('invalid_reset_token');
  });

  it('S01 AS-78: the request is limited to 5 per hour per address and confirm to 10 per hour', async () => {
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

  it('S01 AS-78: more than 3 requests for one account in an hour are 429 alike for known and unknown addresses', async () => {
    const { email } = await member();
    for (let i = 0; i < 3; i++) await request(email).expect(202);
    const known = await request(email).expect(429);
    t.rateTime.advance(2 * 3_600_000 + 1);
    for (let i = 0; i < 3; i++) await request('ghost@example.com').expect(202);
    const unknown = await request('ghost@example.com').expect(429);

    expect(codeOf(known)).toBe(codeOf(unknown));
    expect(known.headers['retry-after']).toBeDefined();
    expect(unknown.headers['retry-after']).toBeDefined();
  });

  it('S01 T071: the purge job deletes tokens expired more than a day ago, in bounded batches, and keeps the rest', async () => {
    const tokens = t.app.get<ResetTokenRepository>(RESET_TOKEN_REPOSITORY);
    const now = t.clock.now();
    const at = (ms: number) => new Date(now.getTime() + ms);
    const DAY = 86_400_000;
    const issue = (expiresAt: Date) =>
      tokens.issue({
        userId: randomUUID(),
        digest: randomUUID(),
        expiresAt,
        now,
      });
    await Promise.all([
      issue(at(-3 * DAY)),
      issue(at(-2 * DAY)),
      issue(at(-DAY - 60_000)),
      issue(at(-DAY + 60_000)),
      issue(at(30 * 60_000)),
    ]);
    const maintenance = t.app.get(ResetTokenMaintenanceService);

    expect(await maintenance.purgeExpired({ batchSize: 2 })).toBe(2);
    expect(await maintenance.purgeExpired({ batchSize: 2 })).toBe(1);
    expect(await maintenance.purgeExpired({ batchSize: 2 })).toBe(0);
    const [{ count }] = await sql.query<{ count: string }>(
      `SELECT count(*) FROM "PasswordResetToken"`,
      { type: QueryTypes.SELECT },
    );
    expect(Number(count)).toBe(2);
  });
});
