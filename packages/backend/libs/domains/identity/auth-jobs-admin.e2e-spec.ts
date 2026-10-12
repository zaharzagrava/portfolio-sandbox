import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  jobsAdminSchemas,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { JobsService } from '@app/infrastructure/jobs';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import { flushRedis } from './testing/mfa-fixtures';
import { IdentityOpsModule } from './identity-ops.module';
import { SessionIssuer } from './application/session-issuer.service';
import { SessionRevocationService } from './application/session-revocation.service';
import { Role } from './infra/models/user.model';

describe('Operator job routes', () => {
  let t: AuthTestApp;
  let sql: Sequelize;
  let jobs: JobsService;
  let admin: string;
  let adminSid: string;

  beforeAll(async () => {
    t = await createAuthApp({ extraImports: [IdentityOpsModule] });
    sql = t.app.get(Sequelize);
    jobs = t.app.get(JobsService);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
    await sql.query(`DELETE FROM "Job" WHERE type = 'jobs.noop'`);
    await sql.query(`DELETE FROM "JobSchedule" WHERE name LIKE 'ops-test-%'`);
    const session = await sessionFor(Role.ADMIN);
    admin = session.accessToken.token;
    adminSid = session.sessionId;
    jest.restoreAllMocks();
  });

  const sessionFor = async (role: Role) => {
    const user = await t.seedUser({ role });
    return t.app.get(SessionIssuer).issue({ userId: user.id, amr: ['pwd'] });
  };
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const as = (method: 'get' | 'post', path: string, token?: string) =>
    t
      .http()
      [method](path)
      .set(token ? bearer(token) : {});
  const noop = async (
    status: 'QUEUED' | 'DEAD' | 'SUCCEEDED' = 'QUEUED',
    extra: { shopId?: string } = {},
  ) => {
    const { id } = await jobs.enqueue('jobs.noop', {}, extra);
    if (status !== 'QUEUED')
      await sql.query(
        `UPDATE "Job" SET status = :status, "finishedAt" = now() WHERE id = :id`,
        { replacements: { status, id } },
      );
    return id;
  };
  const jobRow = async (id: string) =>
    (
      await sql.query<{ status: string; attempts: number }>(
        `SELECT status, attempts FROM "Job" WHERE id = :id`,
        { type: QueryTypes.SELECT, replacements: { id } },
      )
    )[0];
  const schedule = (name: string) =>
    jobs.upsertSchedule({
      name,
      cron: '0 3 * * *',
      jobType: 'jobs.noop',
      payload: {},
    });
  const scheduleRow = async (name: string) =>
    (
      await sql.query<{ enabled: boolean }>(
        `SELECT enabled FROM "JobSchedule" WHERE name = :name`,
        { type: QueryTypes.SELECT, replacements: { name } },
      )
    )[0];

  const routes: Array<['get' | 'post', string]> = [
    ['get', '/api/admin/jobs'],
    ['get', '/api/admin/jobs/stats'],
    ['post', '/api/admin/jobs/00000000-0000-7000-8000-000000000000/retry'],
    ['post', '/api/admin/jobs/00000000-0000-7000-8000-000000000000/cancel'],
    ['get', '/api/admin/job-schedules'],
    ['post', '/api/admin/job-schedules/ops-test-x/enable'],
    ['post', '/api/admin/job-schedules/ops-test-x/disable'],
  ];

  it.each(routes)(
    'OPS-01: %s %s without a token is 401',
    async (method, path) => {
      await as(method, path).expect(401);
    },
  );

  it.each(
    routes.flatMap(([m, p]) =>
      [Role.USER, Role.SELLER, Role.MODERATOR].map((r) => [r, m, p] as const),
    ),
  )('OPS-02: a %s gets 403 on %s %s', async (role, method, path) => {
    const session = await sessionFor(role);
    await as(method, path, session.accessToken.token).expect(403);
  });

  describe('OPS-03: GET /admin/jobs', () => {
    it('lists newest first with the documented fields and never a payload', async () => {
      const first = await noop();
      t.clock.advance(1000);
      const second = await noop('DEAD');

      const res = await as('get', '/api/admin/jobs', admin).expect(200);

      const page = jobsAdminSchemas.list.parse(res.body);
      const ids = page.items.map((i) => i.id);
      expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
      for (const item of res.body.items) {
        expect(Object.keys(item).sort()).toEqual([
          'attempts',
          'createdAt',
          'finishedAt',
          'id',
          'lastError',
          'maxAttempts',
          'runAt',
          'shopId',
          'status',
          'type',
        ]);
      }
      expect(JSON.stringify(res.body)).not.toContain('payload');
    });

    it('filters by status, type and shop', async () => {
      const shopId = '0191a000-0000-7000-8000-000000000001';
      const mine = await noop('QUEUED', { shopId });
      await noop('DEAD');

      const byStatus = await as(
        'get',
        '/api/admin/jobs?status=DEAD',
        admin,
      ).expect(200);
      const byShop = await as(
        'get',
        `/api/admin/jobs?shopId=${shopId}`,
        admin,
      ).expect(200);
      const byType = await as(
        'get',
        '/api/admin/jobs?type=jobs.noop&status=QUEUED',
        admin,
      ).expect(200);
      const none = await as(
        'get',
        '/api/admin/jobs?type=does.not.exist',
        admin,
      ).expect(200);

      expect(
        byStatus.body.items.every(
          (i: { status: string }) => i.status === 'DEAD',
        ),
      ).toBe(true);
      expect(byShop.body.items.map((i: { id: string }) => i.id)).toEqual([
        mine,
      ]);
      expect(byType.body.items.length).toBeGreaterThan(0);
      expect(none.body.items).toEqual([]);
    });

    it('pages with an opaque cursor and clamps the limit to 1–100', async () => {
      for (let i = 0; i < 3; i++) {
        t.clock.advance(1000);
        await noop();
      }

      const one = await as('get', '/api/admin/jobs?limit=2', admin).expect(200);
      expect(one.body.items).toHaveLength(2);
      expect(one.body.nextCursor).toEqual(expect.any(String));
      const two = await as(
        'get',
        `/api/admin/jobs?limit=2&cursor=${encodeURIComponent(one.body.nextCursor)}`,
        admin,
      ).expect(200);
      expect(two.body.items).toHaveLength(1);
      expect(two.body.nextCursor).toBeUndefined();
      expect(
        new Set(
          [...one.body.items, ...two.body.items].map(
            (i: { id: string }) => i.id,
          ),
        ).size,
      ).toBe(3);
      const zero = await as('get', '/api/admin/jobs?limit=0', admin).expect(
        200,
      );
      expect(zero.body.items).toHaveLength(1);
      await as('get', '/api/admin/jobs?limit=100000', admin).expect(200);
    });

    it('answers a tampered cursor and bad filters with 400 validation_failed', async () => {
      const tampered = await as(
        'get',
        '/api/admin/jobs?cursor=not-a-real-cursor',
        admin,
      ).expect(400);
      expect(problemDetailsSchema.parse(tampered.body).code).toBe(
        'validation_failed',
      );
      expect(tampered.body.errors).toEqual([
        { field: 'cursor', code: 'invalid_cursor' },
      ]);
      for (const bad of ['status=NOPE', 'shopId=not-a-uuid', 'limit=abc'])
        await as('get', `/api/admin/jobs?${bad}`, admin).expect(400);
    });
  });

  it('OPS-04: GET /admin/jobs/stats counts per type and status', async () => {
    await noop();
    await noop('DEAD');

    const res = await as('get', '/api/admin/jobs/stats', admin).expect(200);

    const stats = res.body.find(
      (s: { type: string }) => s.type === 'jobs.noop',
    );
    expect(stats.counts).toMatchObject({ QUEUED: 1, DEAD: 1 });
    expect(stats).toHaveProperty('oldestDueRunAt');
    expect(stats).toHaveProperty('lagSeconds');
  });

  describe('OPS-05: POST /admin/jobs/:id/retry', () => {
    it('moves a DEAD job back to QUEUED and audits the actor', async () => {
      const id = await noop('DEAD');
      const lines: unknown[] = [];
      jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation((...args: unknown[]) => void lines.push(args[0]));

      const res = await as('post', `/api/admin/jobs/${id}/retry`, admin).expect(
        200,
      );

      expect(res.body).toEqual({ outcome: 'RETRIED' });
      expect(await jobRow(id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
      const audit = lines.find((l) => (l as { jobId?: string })?.jobId === id);
      expect(audit).toMatchObject({ previousStatus: 'DEAD' });
      expect((audit as { actorId: string }).actorId).toEqual(
        expect.any(String),
      );
    });

    it('answers 409 with the current status for a job that is not DEAD, and 404 for an unknown or malformed id', async () => {
      const id = await noop('QUEUED');

      const conflict = await as(
        'post',
        `/api/admin/jobs/${id}/retry`,
        admin,
      ).expect(409);
      expect(conflict.body).toEqual({ outcome: 'CONFLICT', status: 'QUEUED' });
      expect((await jobRow(id)).status).toBe('QUEUED');
      const missing = await as(
        'post',
        '/api/admin/jobs/00000000-0000-7000-8000-000000000000/retry',
        admin,
      ).expect(404);
      expect(problemDetailsSchema.parse(missing.body).code).toBe(
        'job_not_found',
      );
      await as('post', '/api/admin/jobs/not-a-uuid/retry', admin).expect(404);
    });

    it('is refused for an admin whose session was revoked (sensitive)', async () => {
      const id = await noop('DEAD');
      await t.app.get(SessionRevocationService).revokeBySid(adminSid, 'logout');

      await as('post', `/api/admin/jobs/${id}/retry`, admin).expect(401);
      expect((await jobRow(id)).status).toBe('DEAD');
    });
  });

  it('OPS-06: POST /admin/jobs/:id/cancel cancels a QUEUED job and maps the other outcomes like retry', async () => {
    const queued = await noop('QUEUED');
    const done = await noop('SUCCEEDED');

    const cancelled = await as(
      'post',
      `/api/admin/jobs/${queued}/cancel`,
      admin,
    ).expect(200);
    const conflict = await as(
      'post',
      `/api/admin/jobs/${done}/cancel`,
      admin,
    ).expect(409);
    await as(
      'post',
      '/api/admin/jobs/00000000-0000-7000-8000-000000000000/cancel',
      admin,
    ).expect(404);

    expect(cancelled.body).toEqual({ outcome: 'CANCELLED' });
    expect((await jobRow(queued)).status).toBe('CANCELLED');
    expect(conflict.body).toEqual({ outcome: 'CONFLICT', status: 'SUCCEEDED' });
    expect((await jobRow(done)).status).toBe('SUCCEEDED');
  });

  it('OPS-07: schedules are listed and can be disabled and enabled; an unknown name is 404', async () => {
    await schedule('ops-test-nightly');

    const list = await as('get', '/api/admin/job-schedules', admin).expect(200);
    const mine = list.body.find(
      (s: { name: string }) => s.name === 'ops-test-nightly',
    );
    expect(mine).toMatchObject({
      enabled: true,
      jobType: 'jobs.noop',
      cron: '0 3 * * *',
    });
    jobsAdminSchemas.schedule.parse(mine);

    const off = await as(
      'post',
      '/api/admin/job-schedules/ops-test-nightly/disable',
      admin,
    ).expect(200);
    expect(off.body).toEqual({ name: 'ops-test-nightly', enabled: false });
    expect((await scheduleRow('ops-test-nightly')).enabled).toBe(false);
    const on = await as(
      'post',
      '/api/admin/job-schedules/ops-test-nightly/enable',
      admin,
    ).expect(200);
    expect(on.body).toEqual({ name: 'ops-test-nightly', enabled: true });
    expect((await scheduleRow('ops-test-nightly')).enabled).toBe(true);
    const missing = await as(
      'post',
      '/api/admin/job-schedules/ops-test-nope/enable',
      admin,
    ).expect(404);
    expect(problemDetailsSchema.parse(missing.body).code).toBe(
      'schedule_not_found',
    );
  });
});
