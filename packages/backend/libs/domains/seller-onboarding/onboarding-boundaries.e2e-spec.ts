import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { v4 } from 'uuid';
import {
  documentConfirmResultSchema,
  documentUploadResultSchema,
  onboardingProblemSchema,
  onboardingSubmitResultSchema,
  onboardingViewSchema,
  reviewQueuePageSchema,
  reviewResolveResultSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RequestContext } from '@app/infrastructure/context';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { LlmCallRecorder } from '@app/infrastructure/llm';
import { Role } from '@app/domains/identity';
import { ShopQueryService } from '@app/domains/tenancy';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { OnboardingController } from './api/onboarding.controller';
import { OnboardingReviewController } from './api/review.controller';
import { OnboardingSessionService } from './application/onboarding-session.service';
import { OnboardingJobs } from './infra/onboarding.jobs';
import {
  ANSWERS,
  bankAnswer,
  createOnboardingApp,
  expectContract,
  GOOD_IBAN,
  WITH_VAT,
  type OnboardingTestApp,
  type TestUser,
} from './testing/onboarding-app';

const OWN_TABLES = [
  'ShopOnboarding',
  'ShopDocument',
  'DocumentExtraction',
  'ReviewTask',
  'OnboardingStatusHistory',
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('Seller onboarding: boundaries and observability (e2e)', () => {
  let t: OnboardingTestApp;
  let moderator: TestUser;
  const problem = (body: unknown) =>
    expectContract(onboardingProblemSchema, body);
  const resolve = (taskId: string, body: object, as = moderator) =>
    t
      .http()
      .post(`/api/admin/onboarding/reviews/${taskId}/resolve`)
      .set(as.auth)
      .send(body);

  beforeAll(async () => {
    t = await createOnboardingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.seeds.clean();
    t.llm.reset();
    jest.restoreAllMocks();
    moderator = await t.user(Role.MODERATOR);
  });

  describe('S04 AS-62: schema and ownership', () => {
    it('has the expand-step columns, tables and indexes', async () => {
      const columns = await t.rows<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN (:tables)`,
        { tables: OWN_TABLES },
      );
      const has = (table: string, column: string) =>
        columns.some((c) => c.table_name === table && c.column_name === column);
      for (const column of [
        'status',
        'submissionNo',
        'verifiedAt',
        'rejectedAt',
        'rejectionReasonCode',
        'rejectionReason',
      ])
        expect(has('ShopOnboarding', column)).toBe(true);
      for (const column of ['submissionNo', 'size', 'leaseUntil', 'purgedAt'])
        expect(has('ShopDocument', column)).toBe(true);
      for (const column of ['corrections', 'resolvedBy', 'resolvedAt'])
        expect(has('ReviewTask', column)).toBe(true);
      for (const column of [
        'id',
        'entity',
        'entityId',
        'shopId',
        'fromStatus',
        'toStatus',
        'actor',
        'reasonCode',
        'at',
      ])
        expect(has('OnboardingStatusHistory', column)).toBe(true);
      const indexes = (
        await t.rows<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE tablename IN (:tables)`,
          { tables: OWN_TABLES },
        )
      ).map((i) => i.indexname);
      for (const name of [
        'ux_shopdocument_round_kind_hash',
        'ix_shopdocument_round_kind',
        'ix_shopdocument_lease',
        'ReviewTask_one_open_per_document',
        'ix_reviewtask_open_keyset',
        'ix_reviewtask_open_shop',
        'ix_onboardingstatushistory_entity',
      ])
        expect(indexes).toContain(name);
    });

    it("no onboarding table references another domain's table, and nothing outside references an onboarding table", async () => {
      const fks = await t.rows<{ from: string; to: string }>(
        `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to"
           FROM pg_constraint c WHERE c.contype = 'f'`,
      );
      const unquoted = (name: string) => name.replace(/"/g, '');
      const outbound = fks.filter(
        (f) =>
          OWN_TABLES.includes(unquoted(f.from)) &&
          !OWN_TABLES.includes(unquoted(f.to)),
      );
      const inbound = fks.filter(
        (f) =>
          !OWN_TABLES.includes(unquoted(f.from)) &&
          OWN_TABLES.includes(unquoted(f.to)),
      );
      expect(outbound).toEqual([]);
      expect(inbound).toEqual([]);
      // the old unique that made a file unique per shop (not per round) is gone
      const uniques = await t.rows<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = '"ShopDocument"'::regclass AND contype = 'u'`,
      );
      expect(uniques).toEqual([]);
    });
  });

  it('S04 AS-63: shop names come from one batch call to tenancy; an unknown shop has a null name', async () => {
    const owner = await t.user();
    const shops = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        createShop(t.app, owner, { name: `Shop number ${i}` }),
      ),
    );
    const unknown = v4();
    const ids = [...shops.map((s) => s.id), unknown];
    for (const id of ids)
      await t.db.query(
        `INSERT INTO "ShopDocument" (id, "shopId", kind, "contentType", "contentHash", "storageKey", status)
         SELECT uuidv7(), '${id}', 'BANK_STATEMENT', 'application/pdf', md5(random()::text || g::text) || md5(g::text), 'kyc/${id}/' || g, 'NEEDS_REVIEW'
           FROM generate_series(1, ${id === unknown ? 1 : 3}) g`,
      );
    await t.db.query(
      `INSERT INTO "ReviewTask" ("documentId", "shopId", reasons) SELECT id, "shopId", '[]' FROM "ShopDocument"`,
    );

    const spy = jest.spyOn(
      t.app.get(ShopQueryService, { strict: false }),
      'getShopsByIds',
    );
    const res = await t
      .http()
      .get('/api/admin/onboarding/reviews?limit=100')
      .set(moderator.auth)
      .expect(200);
    const page = expectContract(reviewQueuePageSchema, res.body);
    expect(page.items).toHaveLength(100);
    expect(spy).toHaveBeenCalledTimes(1);
    const asked = spy.mock.calls[0][0] as string[];
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.length).toBeLessThanOrEqual(100);
    expect(
      page.items.find((i) => i.shopId === unknown)?.shopName ?? null,
    ).toBeNull();
    expect(page.items.find((i) => i.shopId === shops[0].id)?.shopName).toBe(
      'Shop number 0',
    );
  });

  it('S04 AS-64: no database transaction is open while the model, storage or queue is called', async () => {
    const idle = async () =>
      Number(
        (
          await t.rows<{ n: string }>(
            `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
          )
        )[0].n,
      );
    const seen: Array<[string, number]> = [];
    const watch = <T extends object>(
      target: T,
      names: Array<keyof T & string>,
      label: string,
    ) => {
      for (const name of names) {
        const original = (target as Record<string, unknown>)[name] as (
          ...args: unknown[]
        ) => Promise<unknown>;
        jest.spyOn(target as never, name as never).mockImplementation((async (
          ...args: unknown[]
        ) => {
          seen.push([`${label}.${name}`, await idle()]);
          return original.apply(target, args);
        }) as never);
      }
    };
    watch(t.llm, ['complete'], 'llm');
    watch(
      t.storage,
      ['head', 'getStream', 'presignGet', 'presignPutChecked', 'delete'],
      'storage',
    );
    const queue = t.app.get(TaskQueue, { strict: false });
    const enqueue = jest.spyOn(queue, 'enqueue');

    const s = await t.submitted();
    const first = await t.needsReview(s); // upload, confirm, extract twice
    await t
      .http()
      .get('/api/admin/onboarding/reviews')
      .set(moderator.auth)
      .expect(200); // link issue
    await resolve(first.taskId, {
      decision: 'REJECT',
      reason: 'blurry scan',
    }).expect(200);
    await t.app
      .get(OnboardingJobs)
      .purge({ shopId: s.shopId, submissionNo: 1 });

    const labels = new Set(seen.map(([label]) => label));
    for (const label of [
      'llm.complete',
      'storage.head',
      'storage.getStream',
      'storage.presignPutChecked',
      'storage.presignGet',
      'storage.delete',
    ])
      expect(labels).toContain(label);
    expect(seen.filter(([, open]) => open > 0)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled(); // the queue is fed by the outbox only
  });

  describe('S04 AS-65: every failure class is problem+json with its stable code', () => {
    const seller = async (answers = ANSWERS) => t.submitted(answers);
    const save = (
      s: TestUser & { shopId: string },
      step: string,
      body: object = ANSWERS.policies,
    ) =>
      t
        .http()
        .put(`/api/shops/${s.shopId}/onboarding/steps/${step}`)
        .set(s.auth)
        .send(body);
    const request = (
      s: TestUser & { shopId: string },
      kind: string,
      text: string,
    ) => {
      const bytes = t.pdf(text);
      return t
        .http()
        .post(`/api/shops/${s.shopId}/onboarding/documents`)
        .set(s.auth)
        .send({
          kind,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.length,
          contentType: 'application/pdf',
        });
    };
    const confirm = (s: TestUser & { shopId: string }, id: string) =>
      t
        .http()
        .post(`/api/shops/${s.shopId}/onboarding/documents/${id}/uploaded`)
        .set(s.auth);
    const setApp = (shopId: string, status: string) =>
      t.db.query(
        `UPDATE "ShopOnboarding" SET status = '${status}' WHERE "shopId" = '${shopId}'`,
      );

    const cases: Array<
      [
        number,
        string,
        () => Promise<{
          status: number;
          headers: Record<string, string>;
          body: unknown;
        }>,
      ]
    > = [
      [400, 'validation_failed', async () => save(await t.seller(), 'nope')],
      [
        401,
        'invalid_token',
        async () => t.http().get(`/api/shops/${v4()}/onboarding`),
      ],
      [
        403,
        'permission_denied',
        async () => {
          const s = await t.seller();
          const m = await t.member(s.shopId, 'STAFF');
          return t.http().get(`/api/shops/${s.shopId}/onboarding`).set(m.auth);
        },
      ],
      [
        403,
        'insufficient_role',
        async () =>
          t
            .http()
            .get('/api/admin/onboarding/reviews')
            .set((await t.seller()).auth),
      ],
      [
        403,
        'conflict_of_interest',
        async () => {
          const s = await seller();
          const task = await t.needsReview(s);
          await addMember(t.app, s.shopId, moderator.id, 'VIEWER');
          return resolve(task.taskId, { decision: 'REJECT', reason: 'mine' });
        },
      ],
      [
        403,
        'shop_suspended',
        async () => {
          const o = await t.user();
          const shop = await createShop(t.app, o, { status: 'SUSPENDED' });
          return save({ ...o, shopId: shop.id }, 'policies');
        },
      ],
      [
        404,
        'shop_not_found',
        async () =>
          t
            .http()
            .get(`/api/shops/${v4()}/onboarding`)
            .set((await t.seller()).auth),
      ],
      [404, 'document_not_found', async () => confirm(await seller(), v4())],
      [
        404,
        'review_task_not_found',
        async () => resolve(v4(), { decision: 'REJECT', reason: 'nobody' }),
      ],
      [409, 'already_submitted', async () => save(await seller(), 'policies')],
      [
        409,
        'submission_required',
        async () => request(await t.seller(), 'BANK_STATEMENT', 'x'),
      ],
      [
        409,
        'resubmission_required',
        async () => {
          const s = await seller();
          await setApp(s.shopId, 'REJECTED');
          return request(s, 'BANK_STATEMENT', 'x');
        },
      ],
      [
        409,
        'already_verified',
        async () => {
          const s = await seller();
          await setApp(s.shopId, 'VERIFIED');
          return request(s, 'BANK_STATEMENT', 'x');
        },
      ],
      [
        409,
        'document_already_approved',
        async () => {
          const s = await seller();
          await t.approved(s, 'BANK_STATEMENT');
          return request(s, 'BANK_STATEMENT', 'another');
        },
      ],
      [
        409,
        'onboarding_document_limit_reached',
        async () => {
          const s = await seller();
          for (let i = 0; i < 5; i++)
            await request(s, 'BANK_STATEMENT', `file ${i}`).expect(201);
          return request(s, 'BANK_STATEMENT', 'sixth');
        },
      ],
      [
        409,
        'upload_not_received',
        async () => {
          const s = await seller();
          const r = await request(s, 'BANK_STATEMENT', 'x');
          return confirm(s, r.body.document.id);
        },
      ],
      [
        409,
        'task_already_resolved',
        async () => {
          const task = await t.needsReview(await seller());
          await resolve(task.taskId, {
            decision: 'REJECT',
            reason: 'first',
          }).expect(200);
          return resolve(task.taskId, { decision: 'REJECT', reason: 'second' });
        },
      ],
      [
        409,
        'document_superseded',
        async () => {
          const s = await seller();
          const task = await t.needsReview(s);
          await t.upload(s, 'BANK_STATEMENT', t.pdf('newer'));
          return resolve(task.taskId, { decision: 'REJECT', reason: 'stale' });
        },
      ],
      [
        409,
        'shop_offboarding',
        async () => {
          const o = await t.user();
          const shop = await createShop(t.app, o, { status: 'DELETING' });
          return save({ ...o, shopId: shop.id }, 'policies');
        },
      ],
      [
        422,
        'document_not_required',
        async () => request(await seller(), 'VAT_CERTIFICATE', 'x'),
      ],
      [
        422,
        'upload_mismatch',
        async () => {
          const s = await seller();
          const bytes = t.pdf('x');
          const r = await request(s, 'BANK_STATEMENT', 'x');
          const [{ storageKey }] = await t.rows<{ storageKey: string }>(
            `SELECT "storageKey" FROM "ShopDocument" WHERE id = :id`,
            { id: r.body.document.id },
          );
          await t.storage.put(
            storageKey,
            Buffer.concat([bytes, Buffer.from('more')]),
            'application/pdf',
          );
          return confirm(s, r.body.document.id);
        },
      ],
      [
        422,
        'iban_invalid',
        async () => {
          const task = await t.needsReview(await seller());
          return resolve(task.taskId, { decision: 'APPROVE' });
        },
      ],
      [
        422,
        'vat_invalid',
        async () => {
          const task = await t.needsReview(
            await seller(WITH_VAT),
            'VAT_CERTIFICATE',
          );
          return resolve(task.taskId, { decision: 'APPROVE' });
        },
      ],
      [
        422,
        'missing_fields',
        async () => {
          const task = await t.needsReview(
            await seller(),
            'BUSINESS_REGISTRATION',
          );
          return resolve(task.taskId, { decision: 'APPROVE' });
        },
      ],
      [
        429,
        'rate_limited',
        async () => {
          const s = await t.seller();
          for (let i = 0; i < 10; i++)
            await t
              .http()
              .post(`/api/shops/${s.shopId}/onboarding/submit`)
              .set(s.auth)
              .expect(400);
          return t
            .http()
            .post(`/api/shops/${s.shopId}/onboarding/submit`)
            .set(s.auth);
        },
      ],
    ];

    it.each(cases)('%i %s', async (status, code, provoke) => {
      const res = await provoke();
      expect(res.status).toBe(status);
      expect(String(res.headers['content-type'])).toContain(
        'application/problem+json',
      );
      const body = problem(res.body);
      expect(body.code).toBe(code);
      for (const member of [
        'type',
        'title',
        'status',
        'detail',
        'instance',
        'requestId',
      ] as const)
        expect(body[member]).toBeDefined();
      expect(body.status).toBe(status);
    });

    it('a forced internal failure answers a generic 500: no SQL, stack or upstream message', async () => {
      const s = await t.seller();
      jest
        .spyOn(t.app.get(OnboardingSessionService), 'view')
        .mockRejectedValue(
          new Error(
            'relation "ShopOnboarding" does not exist: SELECT * FROM "Shop" WHERE secret=1 at /srv/app/dist/main.js:12:7',
          ),
        );
      const res = await t
        .http()
        .get(`/api/shops/${s.shopId}/onboarding`)
        .set(s.auth)
        .expect(500);
      expect(String(res.headers['content-type'])).toContain(
        'application/problem+json',
      );
      const body = problem(res.body);
      expect(body.code).toBe('internal_error');
      const text = JSON.stringify(res.body);
      for (const leak of [
        'SELECT',
        'relation',
        'secret',
        '/srv/app',
        'main.js',
        'stack',
      ])
        expect(text).not.toContain(leak);
    });
  });

  it('S04 AS-66: a full run records the seven series with bounded labels', async () => {
    const s = await t.submitted();
    await t.approved(s, 'BUSINESS_REGISTRATION');
    const task = await t.needsReview(s); // escalation: two attempts, then review
    await resolve(task.taskId, {
      decision: 'APPROVE',
      corrections: { iban: GOOD_IBAN },
    }).expect(200);
    const gone = await t
      .upload(s, 'BANK_STATEMENT', t.pdf('another'))
      .catch(() => null);
    expect(gone).toBeNull(); // approved kind: refused
    const lost = await t.approved(await t.submitted(), 'BANK_STATEMENT');
    const [{ storageKey }] = await t.rows<{ storageKey: string }>(
      `SELECT "storageKey" FROM "ShopDocument" WHERE id = :id`,
      { id: lost },
    );
    const missing = await t.upload(
      await t.submitted(),
      'BANK_STATEMENT',
      t.pdf('vanishing'),
    );
    const [{ storageKey: key2 }] = await t.rows<{ storageKey: string }>(
      `SELECT "storageKey" FROM "ShopDocument" WHERE id = :id`,
      { id: missing.id },
    );
    await t.storage.delete(key2);
    await t.extraction.process(missing.id); // file_missing: a failure counted
    expect(storageKey).toBeDefined();

    const expected: Record<string, string[]> = {
      kyc_extraction_outcomes_total: ['kind', 'attempt', 'outcome'],
      kyc_field_corrections_total: ['kind', 'field'],
      kyc_review_decisions_total: ['kind', 'decision'],
      kyc_extraction_duration_seconds: ['kind', 'outcome'],
      kyc_llm_tokens_total: ['model', 'direction'],
      kyc_extraction_failures_total: ['reason'],
      kyc_review_queue_oldest_age_seconds: [],
    };
    for (const [name, allowed] of Object.entries(expected)) {
      const sets = MetricsRegistry.labelSets(name);
      expect(sets.length).toBeGreaterThan(0);
      for (const labels of sets) {
        for (const key of Object.keys(labels)) expect(allowed).toContain(key);
        for (const value of Object.values(labels))
          expect(String(value)).not.toMatch(UUID);
      }
    }
    expect(
      MetricsRegistry.value('kyc_extraction_failures_total', {
        reason: 'file_missing',
      }),
    ).toBeGreaterThan(0);
  });

  it('S04 AS-67: log lines carry a request id and none contains personal data, a link or a request body', async () => {
    const lines: Array<{ context: string; text: string }> = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
      jest.spyOn(Logger.prototype, level).mockImplementation(function (
        this: { context?: string },
        ...args: unknown[]
      ) {
        lines.push({
          context: String(this.context ?? ''),
          text: args.map(String).join(' '),
        });
      });
    const sentinel = {
      ...ANSWERS,
      business: {
        ...ANSWERS.business,
        businessName: 'Sentinel Trading 7731',
        registrationNumber: 'SENTINEL-REG-9917',
      },
    };
    const s = await t.submitted(sentinel);
    const requests = t.app.get(RequestContext);
    const inRequest = <T>(fn: () => Promise<T>) =>
      requests.run({ requestId: v4() }, fn);

    const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf('statement'));
    t.llm.script({ text: bankAnswer(GOOD_IBAN, 'high', 'Another Holder Ltd') });
    jest
      .spyOn(t.app.get(LlmCallRecorder, { strict: false }), 'record')
      .mockRejectedValueOnce(new Error(`outbox down ${GOOD_IBAN}`));
    await inRequest(() => t.extraction.process(doc.id)); // metering failure: a warn line
    const [task] = await t.rows<{ id: string }>(
      `SELECT id FROM "ReviewTask" WHERE "documentId" = :id`,
      { id: doc.id },
    );
    await t
      .http()
      .get('/api/admin/onboarding/reviews')
      .set(moderator.auth)
      .expect(200);
    await resolve(task.id, {
      decision: 'APPROVE',
      corrections: { accountHolder: 'Sentinel Trading 7731' },
    }).expect(200);
    await resolve(task.id, {
      decision: 'REJECT',
      reason: 'a secret reason',
    }).expect(409);
    await t
      .http()
      .put(`/api/shops/${s.shopId}/onboarding/steps/policies`)
      .set(s.auth)
      .send(ANSWERS.policies)
      .expect(409);
    const real = t.storage.delete.bind(t.storage);
    jest
      .spyOn(t.storage, 'delete')
      .mockImplementation(() => Promise.reject(new Error('storage down')));
    await inRequest(() =>
      t.app
        .get(OnboardingJobs)
        .purge({ shopId: s.shopId, submissionNo: 1 })
        .catch(() => undefined),
    ); // warn line
    jest.restoreAllMocks();
    void real;

    const ours = lines.filter(
      (l) =>
        [
          'ExtractionService',
          'RetentionService',
          'AllExceptionsFilter',
        ].includes(l.context) ||
        (l.context === 'Audit' &&
          l.text.includes('"audit":"seller-onboarding"')),
    );
    expect(ours.length).toBeGreaterThan(3);
    for (const l of ours) expect(l.text).toMatch(/requestId/);
    const all = lines.map((l) => l.text).join('\n');
    for (const secret of [
      '3704',
      '0532',
      GOOD_IBAN,
      'DE89',
      'Sentinel',
      'SENTINEL-REG',
      'a secret reason',
      'Müller',
      'X-Amz',
      'http://',
      'https://',
    ])
      expect(all).not.toContain(secret);
  });

  describe('S04 AS-68: every endpoint has a contract schema', () => {
    it('lists exactly the routes that have a schema', () => {
      const routeOf = (controller: object, method: string) => {
        const fn = (controller as Record<string, unknown>)[method] as object;
        const path = Reflect.getMetadata(PATH_METADATA, fn) as string;
        const verb =
          RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
        const prefix =
          (Reflect.getMetadata(
            PATH_METADATA,
            controller.constructor,
          ) as string) || '';
        return `${verb} /${`${prefix}/${path}`.split('/').filter(Boolean).join('/')}`;
      };
      const routes = [
        ...Object.getOwnPropertyNames(OnboardingController.prototype)
          .filter((m) => m !== 'constructor')
          .map((m) => routeOf(OnboardingController.prototype, m)),
        ...Object.getOwnPropertyNames(OnboardingReviewController.prototype)
          .filter((m) => m !== 'constructor')
          .map((m) => routeOf(OnboardingReviewController.prototype, m)),
      ].sort();
      const schemas: Record<string, unknown> = {
        'PUT /shops/:shopId/onboarding/steps/:step': onboardingViewSchema,
        'GET /shops/:shopId/onboarding': onboardingViewSchema,
        'POST /shops/:shopId/onboarding/submit': onboardingSubmitResultSchema,
        'POST /shops/:shopId/onboarding/documents': documentUploadResultSchema,
        'POST /shops/:shopId/onboarding/documents/:documentId/uploaded':
          documentConfirmResultSchema,
        'GET /admin/onboarding/reviews': reviewQueuePageSchema,
        'POST /admin/onboarding/reviews/:taskId/resolve':
          reviewResolveResultSchema,
      };
      expect(routes).toEqual(Object.keys(schemas).sort());
    });
  });

  describe('S04 T071 / AS-62: the sources import and query only what the capability owns', () => {
    const sources = () => {
      const root = join(__dirname);
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== 'testing') walk(path);
          } else if (
            path.endsWith('.ts') &&
            !/\.(spec|e2e-spec)\.ts$/.test(path)
          )
            files.push(path);
        }
      };
      walk(root);
      return files.map((file) => ({ file, text: readFileSync(file, 'utf8') }));
    };

    it('no ClickHouse, Kafka producer, billing or assistant import and no query on the shop table', () => {
      for (const { file, text } of sources()) {
        for (const forbidden of [
          /infrastructure\/clickhouse/,
          /infrastructure\/kafka\/kafka-producer/,
          /domains\/billing/,
          /domains\/assistant/,
        ])
          expect([file, forbidden.test(text)]).toEqual([file, false]);
        expect([
          file,
          /(FROM|JOIN|UPDATE|INTO)\s+"Shop"(?!\w)/i.test(text),
        ]).toEqual([file, false]);
      }
    });
  });

  describe('S04 T071: the applications boot with what they need and nothing more', () => {
    it('the full OnboardingModule serves its routes in the API app', async () => {
      const s = await t.seller();
      await t
        .http()
        .get(`/api/shops/${s.shopId}/onboarding`)
        .set(s.auth)
        .expect(200);
      await t
        .http()
        .get('/api/admin/onboarding/reviews')
        .set(moderator.auth)
        .expect(200);
    });
  });

  // The extraction Lambda's own app (no ClickHouse, billing or assistant module) is booted by
  // apps/lambdas/src/handlers/document-extractor.e2e-spec.ts (L-018): libs must not import apps.
});
