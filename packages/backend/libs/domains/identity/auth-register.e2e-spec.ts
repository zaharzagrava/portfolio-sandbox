import { getModelToken } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  acceptedSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { AuthTestApp, createAuthApp, TEST_PASSWORD } from './testing/auth-app';
import { PasswordHasher } from './infra/crypto/password-hasher';
import User from './infra/models/user.model';

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

describe('Registration', () => {
  let t: AuthTestApp;
  let users: typeof User;
  let sequelize: Sequelize;

  const register = (body: Record<string, unknown>) =>
    t.http().post('/api/auth/register').send(body);
  const userRows = (email: string) =>
    users.findAll({ where: { email }, paranoid: false, raw: true });

  beforeAll(async () => {
    t = await createAuthApp();
    users = t.app.get(getModelToken(User));
    sequelize = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    jest.restoreAllMocks();
  });

  it('S01 AS-01: a new address gets 202, one user, one user_registered event, no session and no cookie', async () => {
    const res = await register({
      email: '  New@Example.COM ',
      password: TEST_PASSWORD,
    }).expect(202);

    expect(acceptedSchema.parse(res.body)).toEqual({ status: 'accepted' });
    expect(res.headers['set-cookie']).toBeUndefined();

    const rows = await userRows('new@example.com');
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('USER');
    expect(rows[0].passwordHash).toMatch(
      /^\$argon2id\$v=19\$m=19456,(t=2,p=1|p=1,t=2)\$/,
    );

    const { Items } = await t.app
      .get(DynamoService)
      .doc.send(
        new ScanCommand({ TableName: t.app.get(DynamoService).table('Auth') }),
      );
    expect(Items ?? []).toHaveLength(0); // no session

    const events = await outboxRowsFor(t.app, rows[0].id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'event',
      type: 'identity.user_registered',
    });
    expect(events[0].payload).toMatchObject({
      type: 'identity.user_registered',
      version: 1,
      aggregateId: rows[0].id,
      payload: { userId: rows[0].id, role: 'USER' },
    });
    expect(JSON.stringify(events[0].payload)).not.toMatch(
      /example\.com|argon2/,
    );
  });

  it('S01 AS-02: a taken address (any case, any spacing) answers byte-identically and writes a duplicate event per request', async () => {
    const first = await register({
      email: 'new@example.com',
      password: TEST_PASSWORD,
    });
    const p2 = 'another valid passphrase';
    const variants = [
      'new@example.com',
      'NEW@example.com',
      ' new@example.com ',
    ];
    const responses: Awaited<ReturnType<typeof register>>[] = [];
    for (const email of variants)
      responses.push(await register({ email, password: p2 }).expect(202));

    for (const res of responses) {
      expect(res.text).toBe(first.text);
      expect(stableHeaders(res.headers)).toEqual(stableHeaders(first.headers));
    }

    const rows = await userRows('new@example.com');
    expect(rows).toHaveLength(1);
    const events = await outboxRowsFor(t.app, rows[0].id);
    expect(
      events.filter((e) => e.type === 'identity.user_registered'),
    ).toHaveLength(1);
    const duplicates = events.filter(
      (e) => e.type === 'identity.registration_duplicate_attempted',
    );
    expect(duplicates).toHaveLength(3);
    expect(duplicates[0].payload).toMatchObject({
      version: 1,
      payload: { userId: rows[0].id },
    });

    const hasher = new PasswordHasher();
    expect(
      (await hasher.verify(TEST_PASSWORD, rows[0].passwordHash)).valid,
    ).toBe(true);
    expect((await hasher.verify(p2, rows[0].passwordHash)).valid).toBe(false);
  });

  it('S01 AS-03: simultaneous registrations of one address create one user, one of each event, and the store refuses a case variant', async () => {
    const [a, b] = await Promise.all([
      register({ email: 'race@example.com', password: 'first password value' }),
      register({
        email: 'race@example.com',
        password: 'second password value',
      }),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);

    const rows = await userRows('race@example.com');
    expect(rows).toHaveLength(1);
    const events = await outboxRowsFor(t.app, rows[0].id);
    expect(events.map((e) => e.type).sort()).toEqual([
      'identity.registration_duplicate_attempted',
      'identity.user_registered',
    ]);

    const hasher = new PasswordHasher();
    const matches = await Promise.all(
      ['first password value', 'second password value'].map(
        async (p) => (await hasher.verify(p, rows[0].passwordHash)).valid,
      ),
    );
    expect(matches.filter(Boolean)).toHaveLength(1);

    // The store itself, not the application, refuses the same address in another letter case.
    await expect(
      users.create({ email: 'RACE@EXAMPLE.COM', passwordHash: 'x' }),
    ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  });

  it('S01 AS-03: address lookups use the lower(email) unique index', async () => {
    await register({ email: 'indexed@example.com', password: TEST_PASSWORD });
    // Force the planner away from a sequential scan so the plan names the index it can use (tiny table).
    const plan = await t.app.get(TransactionRunner).run(async (transaction) => {
      await sequelize.query('SET LOCAL enable_seqscan = off', { transaction });
      return sequelize.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT "id" FROM "User" WHERE lower("email") = 'indexed@example.com'`,
        { transaction, type: QueryTypes.SELECT },
      );
    });
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toMatch(
      /User_lower_email_uq|User_lower_email_idx/,
    );
  });

  it.each([
    [undefined, 'USER'],
    ['USER', 'USER'],
    ['SELLER', 'SELLER'],
  ])('S01 AS-04: role %s is stored as %s', async (role, stored) => {
    await register({
      email: 'role@example.com',
      password: TEST_PASSWORD,
      role,
    }).expect(202);
    expect((await userRows('role@example.com'))[0].role).toBe(stored);
  });

  it.each([
    ['ADMIN role', { role: 'ADMIN' }, 'role'],
    ['MODERATOR role', { role: 'MODERATOR' }, 'role'],
    ['unknown field isAdmin', { isAdmin: true }, 'isAdmin'],
  ])(
    'S01 AS-04: %s is refused with validation_failed naming the field, nothing persisted',
    async (_name, extra, field) => {
      const res = await register({
        email: 'mass@example.com',
        password: TEST_PASSWORD,
        ...extra,
      }).expect(400);
      const problem = problemDetailsSchema.parse(res.body);
      expect(problem.code).toBe('validation_failed');
      expect(problem.errors?.map((e) => e.field)).toContain(field);
      expect(await userRows('mass@example.com')).toHaveLength(0);
    },
  );

  const longEmail = `${'a'.repeat(250)}@example.com`;
  it.each([
    ['email missing', { password: TEST_PASSWORD }, 'email'],
    ['email not a string', { email: 42, password: TEST_PASSWORD }, 'email'],
    [
      'email not an address',
      { email: 'nope', password: TEST_PASSWORD },
      'email',
    ],
    ['email empty', { email: '', password: TEST_PASSWORD }, 'email'],
    ['email over 254', { email: longEmail, password: TEST_PASSWORD }, 'email'],
    ['password missing', { email: 'v@example.com' }, 'password'],
    [
      'password not a string',
      { email: 'v@example.com', password: 123456789012 },
      'password',
    ],
    [
      'password under 12',
      { email: 'v@example.com', password: 'short-pass' },
      'password',
    ],
    [
      'password over 128',
      { email: 'v@example.com', password: 'p'.repeat(129) },
      'password',
    ],
  ])(
    'S01 AS-05: %s → 400 with a per-field error, no echo, no hash, no user',
    async (_name, body, field) => {
      const hash = jest.spyOn(PasswordHasher.prototype, 'hash');
      const res = await register(body).expect(400);
      const problem = problemDetailsSchema.parse(res.body);
      expect(problem.code).toBe('validation_failed');
      expect(problem.errors?.map((e) => e.field)).toContain(field);
      const submittedPassword = (body as { password?: unknown }).password;
      if (typeof submittedPassword === 'string')
        expect(res.text).not.toContain(submittedPassword);
      expect(hash).not.toHaveBeenCalled();
      expect(await sequelize.query('SELECT 1 FROM "User"')).toEqual([
        [],
        expect.anything(),
      ]);
      expect(
        await outboxRowsFor(t.app, '00000000-0000-0000-0000-000000000000'),
      ).toEqual([]);
    },
  );

  it('S01 AS-05: a password equal to the address is a weak password', async () => {
    const res = await register({
      email: 'same.as.password@example.com',
      password: 'same.as.password@example.com',
    }).expect(422);
    expect(problemDetailsSchema.parse(res.body).code).toBe('weak_password');
  });

  it.each(['new', 'existing'])(
    'S01 AS-06: a breached password is 422 weak_password for a %s address and persists nothing',
    async (kind) => {
      const breached = 'breached passphrase 1';
      t.breach.breached.add(breached);
      if (kind === 'existing')
        await register({
          email: 'old@example.com',
          password: TEST_PASSWORD,
        }).expect(202);
      const before = await sequelize.query(
        'SELECT count(*)::int AS n FROM "Outbox"',
        {
          type: QueryTypes.SELECT,
        },
      );

      const res = await register({
        email: kind === 'new' ? 'fresh@example.com' : 'old@example.com',
        password: breached,
      }).expect(422);

      expect(problemDetailsSchema.parse(res.body).code).toBe('weak_password');
      expect(await userRows('fresh@example.com')).toHaveLength(0);
      expect(
        await sequelize.query('SELECT count(*)::int AS n FROM "Outbox"', {
          type: QueryTypes.SELECT,
        }),
      ).toEqual(before);
    },
  );

  it.each(['throw', 'timeout'] as const)(
    'S01 AS-07: the corpus failing (%s) fails open and counts the skip',
    async (mode) => {
      t.breach.mode = mode;
      const counter = () =>
        MetricsRegistry.value('auth_breach_check_skipped_total') ?? 0;
      const before = counter();

      await register({
        email: 'open@example.com',
        password: TEST_PASSWORD,
      }).expect(202);

      expect(await userRows('open@example.com')).toHaveLength(1);
      expect(counter()).toBe(before + 1);
    },
  );

  it('S01 AS-08: one hash computation per request, for a new and for an existing address', async () => {
    const hash = jest.spyOn(PasswordHasher.prototype, 'hash');
    await register({
      email: 'equal@example.com',
      password: TEST_PASSWORD,
    }).expect(202);
    expect(hash).toHaveBeenCalledTimes(1);
    hash.mockClear();
    await register({
      email: 'equal@example.com',
      password: TEST_PASSWORD,
    }).expect(202);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('S01 AS-09: the 11th registration from one address within the hour is 429 with Retry-After and creates nothing', async () => {
    for (let i = 0; i < 10; i++)
      await register({
        email: `limit${i}@example.com`,
        password: TEST_PASSWORD,
      }).expect(202);

    const res = await register({
      email: 'limit-over@example.com',
      password: TEST_PASSWORD,
    }).expect(429);

    expect(problemDetailsSchema.parse(res.body).code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(await userRows('limit-over@example.com')).toHaveLength(0);
  });
});
