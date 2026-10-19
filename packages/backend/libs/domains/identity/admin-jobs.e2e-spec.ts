import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import {
  adminJobAcceptedSchema,
  adminJobSchema,
  problemDetailsSchema,
} from '@marketplace-sandbox/contracts';
import { IdempotencyRepository } from '@app/infrastructure/idempotency';
import { requestFingerprint } from '@app/infrastructure/idempotency/fingerprint';
// The allow-listed job types are declared by their owners; the admin route only enqueues them.
// the allow-listed job types are declared by the owning domains: loading their public entry points registers them
import '@app/domains/payments';
import '@app/domains/statements';
import '@app/domains/billing';
import '@app/domains/developer-platform';
import '@app/domains/discovery';
import '@app/domains/seller-onboarding';
import '@app/domains/launch-events';
import '@app/domains/auctions';
import '@app/domains/orders';
import '@app/domains/catalog-sync';
import { AuthTestApp, createAuthApp } from './testing/auth-app';
import { flushRedis } from './testing/mfa-fixtures';
import { IdentityOpsModule } from './identity-ops.module';
import { SessionIssuer } from './application/session-issuer.service';
import { Role } from './infra/models/user.model';

const ALLOWED = [
  'payouts.run-weekly',
  'statements.close-month',
  'payments.reconcile-daily',
];

const J02_TYPES = [
  'billing.run',
  'onboarding.verify-pending',
  'webhooks.retry',
  'search.reindex',
];

describe('J01 G-30: admin job requests (POST/GET /api/admin/jobs)', () => {
  let t: AuthTestApp;
  let sql: Sequelize;
  let adminId: string;
  let admin: string;
  let seq = 0;

  beforeAll(async () => {
    t = await createAuthApp({ extraImports: [IdentityOpsModule] });
    sql = t.app.get(Sequelize);
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await flushRedis(t);
    await sql.query(`DELETE FROM "Job" WHERE type IN (:types)`, {
      replacements: { types: [...ALLOWED, ...J02_TYPES] },
    });
    const session = await sessionFor(Role.ADMIN);
    admin = session.accessToken.token;
    adminId = session.userId;
  });

  const sessionFor = async (role: Role) => {
    const user = await t.seedUser({ role });
    const issued = await t.app
      .get(SessionIssuer)
      .issue({ userId: user.id, amr: ['pwd'] });
    return { ...issued, userId: user.id };
  };
  const key = () => `j01-g30-key-${Date.now()}-${++seq}`;
  const post = (
    body: unknown,
    opts: { token?: string | null; key?: string | null } = {},
  ) => {
    const token = opts.token === undefined ? admin : opts.token;
    const k = opts.key === undefined ? key() : opts.key;
    let req = t.http().post('/api/admin/jobs');
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    if (k) req = req.set('Idempotency-Key', k);
    return req.send(body as object);
  };
  const jobsOf = (type: string) =>
    sql.query<{
      id: string;
      type: string;
      status: string;
      payload: Record<string, unknown>;
      runAt: Date;
      createdAt: Date;
    }>(
      `SELECT id, type, status, payload, "runAt", "createdAt" FROM "Job" WHERE type = :type`,
      { type: QueryTypes.SELECT, replacements: { type } },
    );
  const allJobs = async () =>
    (
      await sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Job" WHERE type IN (:types)`,
        { type: QueryTypes.SELECT, replacements: { types: ALLOWED } },
      )
    )[0].n;

  it('J01 G-30: POST answers 202 {jobId} and persists one QUEUED job due now, for each allow-listed type', async () => {
    const bodies = [
      { type: 'payouts.run-weekly', payload: { periodStart: '2026-01-05' } },
      { type: 'statements.close-month', payload: { month: '2026-01' } },
      { type: 'payments.reconcile-daily', payload: { day: '2026-01-02' } },
    ];
    for (const body of bodies) {
      const res = await post(body).expect(202);
      const { jobId } = adminJobAcceptedSchema.parse(res.body);

      const rows = await jobsOf(body.type);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(jobId);
      expect(rows[0].status).toBe('QUEUED');
      expect(rows[0].payload).toEqual(body.payload);
      expect(rows[0].runAt.getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it('S01 G-37: billing.run, onboarding.verify-pending, webhooks.retry and search.reindex are on the allow-list', async () => {
    const bodies = [
      { type: 'billing.run', payload: {} },
      { type: 'onboarding.verify-pending', payload: {} },
      {
        type: 'webhooks.retry',
        payload: {
          endpointId: 'e1',
          eventId: 'evt_1',
          deliveryId: 'dlv_1',
          kind: 'event',
          attempt: 2,
        },
      },
      {
        type: 'search.reindex',
        payload: { runId: '00000000-0000-4000-8000-000000000001' },
      },
    ];
    try {
      for (const body of bodies) {
        const res = await post(body).expect(202);
        const { jobId } = adminJobAcceptedSchema.parse(res.body);
        const rows = await jobsOf(body.type);
        expect(rows.map((r) => r.id)).toEqual([jobId]);
        expect(rows[0].status).toBe('QUEUED');
      }
    } finally {
      await sql.query(`DELETE FROM "Job" WHERE type IN (:types)`, {
        replacements: { types: J02_TYPES },
      });
    }
  });

  it('J03 G-40: the launch-day jobs are on the allow-list and enqueue one QUEUED job each; an unknown type stays 422', async () => {
    const types = [
      'launch-events.reconcile-seats',
      'auctions.sweep-due',
      'flash-sale.verify',
      'launch-events.live-reconcile',
    ];
    try {
      for (const type of types) {
        const res = await post({ type, payload: {} }).expect(202);
        const { jobId } = adminJobAcceptedSchema.parse(res.body);
        const rows = await jobsOf(type);
        expect(rows.map((r) => r.id)).toEqual([jobId]);
        expect(rows[0].status).toBe('QUEUED');
      }
      const refused = await post({ type: 'auctions.sweep-never' }).expect(422);
      expect(problemDetailsSchema.parse(refused.body).code).toBe(
        'job_type_not_allowed',
      );
      const nonAdmin = await sessionFor(Role.SELLER);
      await post(
        { type: 'auctions.sweep-due', payload: {} },
        { token: nonAdmin.accessToken.token },
      ).expect(403);
    } finally {
      await sql.query(`DELETE FROM "Job" WHERE type IN (:types)`, {
        replacements: { types },
      });
    }
  });

  it('J04 G-22: the catalog-sync jobs are on the allow-list, each request enqueues one QUEUED job, and non-admins are refused', async () => {
    const types = [
      'catalog-sync.sync-all',
      'catalog-sync.reconcile-all',
      'catalog-sync.recover-stalled-imports',
    ];
    try {
      for (const type of types) {
        const res = await post({ type, payload: {} }).expect(202);
        const { jobId } = adminJobAcceptedSchema.parse(res.body);
        const rows = await jobsOf(type);
        expect(rows.map((r) => r.id)).toEqual([jobId]);
        expect(rows[0].status).toBe('QUEUED');
      }
      const nonAdmin = await sessionFor(Role.SELLER);
      await post(
        { type: 'catalog-sync.sync-all', payload: {} },
        { token: nonAdmin.accessToken.token },
      ).expect(403);
    } finally {
      await sql.query(`DELETE FROM "Job" WHERE type IN (:types)`, {
        replacements: { types },
      });
    }
  });

  it('J01 G-30: an omitted payload is accepted for a type whose payload is optional', async () => {
    const res = await post({ type: 'payments.reconcile-daily' }).expect(202);
    const rows = await jobsOf('payments.reconcile-daily');
    expect(rows.map((r) => r.id)).toEqual([res.body.jobId]);
    expect(rows[0].payload).toEqual({});
  });

  it('J01 G-30: a type outside the allow-list is 422 job_type_not_allowed and nothing is enqueued', async () => {
    for (const type of ['jobs.noop', 'payouts.send', 'no.such.type']) {
      const res = await post({ type, payload: {} }).expect(422);
      expect(problemDetailsSchema.parse(res.body).code).toBe(
        'job_type_not_allowed',
      );
    }
    expect(await allJobs()).toBe(0);
    expect(
      (
        await sql.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "Job" WHERE type IN ('jobs.noop', 'payouts.send', 'no.such.type')`,
          { type: QueryTypes.SELECT },
        )
      )[0].n,
    ).toBe(0);
  });

  it('J01 G-30: a malformed periodStart is 422 invalid_payload and nothing is enqueued', async () => {
    const res = await post({
      type: 'payouts.run-weekly',
      payload: { periodStart: 'next-monday' },
    }).expect(422);
    expect(problemDetailsSchema.parse(res.body).code).toBe('invalid_payload');
    expect(await allJobs()).toBe(0);
  });

  it('J01 G-30: a malformed month or an unknown payload field is 422 invalid_payload', async () => {
    const month = await post({
      type: 'statements.close-month',
      payload: { month: '2026-13' },
    }).expect(422);
    expect(month.body.code).toBe('invalid_payload');
    const extra = await post({
      type: 'payouts.run-weekly',
      payload: { periodStart: '2026-01-05', shopId: 'x' },
    }).expect(422);
    expect(extra.body.code).toBe('invalid_payload');
    expect(await allJobs()).toBe(0);
  });

  it('J01 G-30: a body without a type is 400 validation_failed', async () => {
    const res = await post({ payload: {} }).expect(400);
    expect(res.body.code).toBe('validation_failed');
    expect(await allJobs()).toBe(0);
  });

  it('J01 G-30: a missing Idempotency-Key is 422 idempotency_key_required and nothing is enqueued', async () => {
    const res = await post(
      { type: 'payouts.run-weekly', payload: {} },
      { key: null },
    ).expect(422);
    expect(res.body.code).toBe('idempotency_key_required');
    expect(await allJobs()).toBe(0);
  });

  it('J01 G-30: without a token POST and GET are 401', async () => {
    await post(
      { type: 'payouts.run-weekly', payload: {} },
      { token: null },
    ).expect(401);
    await t
      .http()
      .get('/api/admin/jobs/00000000-0000-7000-8000-000000000000')
      .expect(401);
    expect(await allJobs()).toBe(0);
  });

  it.each([Role.USER, Role.SELLER, Role.MODERATOR])(
    'J01 G-30: a %s gets 403 on POST and GET and nothing is enqueued',
    async (role) => {
      const session = await sessionFor(role);
      const token = session.accessToken.token;
      await post({ type: 'payouts.run-weekly', payload: {} }, { token }).expect(
        403,
      );
      await t
        .http()
        .get('/api/admin/jobs/00000000-0000-7000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect(await allJobs()).toBe(0);
    },
  );

  it('J01 G-30: the same key and body return the same jobId and one job exists', async () => {
    const k = key();
    const body = {
      type: 'payouts.run-weekly',
      payload: { periodStart: '2026-01-05' },
    };
    const first = await post(body, { key: k }).expect(202);
    const second = await post(body, { key: k }).expect(202);

    expect(second.body.jobId).toBe(first.body.jobId);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(await jobsOf('payouts.run-weekly')).toHaveLength(1);
  });

  it('J01 G-30: a request whose first attempt is still in flight is 409 idempotency_in_flight', async () => {
    const k = key();
    const body = {
      type: 'payouts.run-weekly',
      payload: { periodStart: '2026-01-05' },
    };
    const claim = await t.app.get(IdempotencyRepository).claim({
      scope: `admin-jobs:${adminId}`,
      key: k,
      fingerprint: requestFingerprint({
        method: 'POST',
        path: '/api/admin/jobs',
        rawQuery: '',
        body,
      }),
      now: t.clock.now(),
      ttlMs: 60_000,
      lockMs: 60_000,
    });
    expect(claim.claimed).toBe(true);

    const res = await post(body, { key: k }).expect(409);

    expect(res.body.code).toBe('idempotency_in_flight');
    expect(await allJobs()).toBe(0);
  });

  it('J01 G-30: the same key with a different body is 422 idempotency_key_reuse and the first job stays', async () => {
    const k = key();
    const first = await post(
      { type: 'payouts.run-weekly', payload: { periodStart: '2026-01-05' } },
      { key: k },
    ).expect(202);

    const res = await post(
      { type: 'payouts.run-weekly', payload: { periodStart: '2026-01-12' } },
      { key: k },
    ).expect(422);

    expect(res.body.code).toBe('idempotency_key_reuse');
    const rows = await jobsOf('payouts.run-weekly');
    expect(rows.map((r) => r.id)).toEqual([first.body.jobId]);
    expect(rows[0].payload).toEqual({ periodStart: '2026-01-05' });
  });

  it('J01 G-30: the same key text from another admin is a separate request', async () => {
    const other = await sessionFor(Role.ADMIN);
    const k = key();
    const body = { type: 'payouts.run-weekly', payload: {} };
    const mine = await post(body, { key: k }).expect(202);
    const theirs = await post(body, {
      key: k,
      token: other.accessToken.token,
    }).expect(202);

    expect(theirs.body.jobId).not.toBe(mine.body.jobId);
    expect(await jobsOf('payouts.run-weekly')).toHaveLength(2);
  });

  it('J01 G-30: five concurrent requests with one key create one job', async () => {
    const k = key();
    const body = {
      type: 'payouts.run-weekly',
      payload: { periodStart: '2026-01-05' },
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(body, { key: k })),
    );

    const accepted = results.filter((r) => r.status === 202);
    const busy = results.filter((r) => r.status === 409);
    expect(accepted.length + busy.length).toBe(5);
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    for (const r of busy) expect(r.body.code).toBe('idempotency_in_flight');
    const rows = await jobsOf('payouts.run-weekly');
    expect(rows).toHaveLength(1);
    for (const r of accepted) expect(r.body.jobId).toBe(rows[0].id);
  });

  describe('GET /api/admin/jobs/:jobId', () => {
    const get = (id: string, token: string = admin) =>
      t
        .http()
        .get(`/api/admin/jobs/${id}`)
        .set('Authorization', `Bearer ${token}`);

    it('J01 G-30: returns id, type, status, attempts and finishedAt without the payload', async () => {
      const { body } = await post({
        type: 'statements.close-month',
        payload: { month: '2026-01' },
      }).expect(202);

      const queued = adminJobSchema.parse(
        (await get(body.jobId).expect(200)).body,
      );
      expect(queued).toEqual({
        id: body.jobId,
        type: 'statements.close-month',
        status: 'QUEUED',
        attempts: 0,
        finishedAt: null,
      });
      expect((await get(body.jobId)).body).not.toHaveProperty('payload');

      await sql.query(
        `UPDATE "Job" SET status = 'SUCCEEDED', attempts = 1, "finishedAt" = '2026-02-01T00:00:00Z' WHERE id = :id`,
        { replacements: { id: body.jobId } },
      );
      const done = adminJobSchema.parse(
        (await get(body.jobId).expect(200)).body,
      );
      expect(done).toEqual({
        id: body.jobId,
        type: 'statements.close-month',
        status: 'SUCCEEDED',
        attempts: 1,
        finishedAt: '2026-02-01T00:00:00.000Z',
      });
    });

    it('J01 G-30: an unknown or malformed id is 404 job_not_found', async () => {
      for (const id of ['00000000-0000-7000-8000-000000000000', 'not-an-id']) {
        const res = await get(id).expect(404);
        expect(problemDetailsSchema.parse(res.body).code).toBe('job_not_found');
      }
    });
  });
});
