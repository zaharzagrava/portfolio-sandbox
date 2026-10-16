import { v4 } from 'uuid';
import {
  onboardingProblemSchema,
  onboardingSubmitResultSchema,
  onboardingViewSchema,
} from '@marketplace-sandbox/contracts';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import {
  ANSWERS,
  createOnboardingApp,
  expectContract,
  WITH_VAT,
  type OnboardingTestApp,
  type Seller,
} from './testing/onboarding-app';

describe('Seller onboarding: staged questionnaire (e2e)', () => {
  let t: OnboardingTestApp;
  const redis = () => t.app.get(RedisService).client;
  const draftKey = (shopId: string) => `onboarding:draft:${shopId}`;
  const step = (s: Seller, name: string, body: unknown, shopId = s.shopId) =>
    t
      .http()
      .put(`/api/shops/${shopId}/onboarding/steps/${name}`)
      .set(s.auth)
      .send(body as object);
  const view = (s: Seller) =>
    t.http().get(`/api/shops/${s.shopId}/onboarding`).set(s.auth);
  const submit = (s: Seller) =>
    t.http().post(`/api/shops/${s.shopId}/onboarding/submit`).set(s.auth);
  const applicationRows = (shopId: string) =>
    t.rows<{ status: string; submissionNo: number; submittedBy: string }>(
      `SELECT status, "submissionNo", "submittedBy" FROM "ShopOnboarding" WHERE "shopId" = :shopId`,
      { shopId },
    );
  const events = async (shopId: string, type: string) =>
    (await t.outbox(shopId)).filter((r) => r.type === type);

  beforeAll(async () => {
    t = await createOnboardingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.seeds.clean();
  });

  it('S04 AS-01: a valid step answers the view, keeps a 7-day draft key, writes no row and no event', async () => {
    const s = await t.seller();
    const res = await step(s, 'business', ANSWERS.business).expect(200);
    const body = expectContract(onboardingViewSchema, res.body);
    expect(body).toEqual({
      status: 'DRAFT',
      submissionNo: null,
      answers: { business: ANSWERS.business },
      missingSteps: ['tax', 'catalog', 'policies'],
      requiredDocuments: null,
      documents: [],
    });
    const ttl = await redis().ttl(draftKey(s.shopId));
    expect(ttl).toBeGreaterThanOrEqual(7 * 86_400 - 5);
    expect(ttl).toBeLessThanOrEqual(7 * 86_400);
    expect(await applicationRows(s.shopId)).toEqual([]);
    expect(await t.outbox(s.shopId)).toEqual([]);
  });

  describe('S04 AS-02: step validation', () => {
    const cases: Array<[string, string, unknown, string]> = [
      ['business', 'non-object body', [1, 2], 'body'],
      ['business', 'unknown field', { ...ANSWERS.business, extra: 1 }, 'extra'],
      [
        'business',
        'country outside the EU list',
        { ...ANSWERS.business, country: 'US' },
        'country',
      ],
      [
        'business',
        'legalForm outside the four',
        { ...ANSWERS.business, legalForm: 'DAO' },
        'legalForm',
      ],
      [
        'business',
        'businessName of 1',
        { ...ANSWERS.business, businessName: 'A' },
        'businessName',
      ],
      [
        'business',
        'businessName of 201',
        { ...ANSWERS.business, businessName: 'A'.repeat(201) },
        'businessName',
      ],
      [
        'business',
        'registrationNumber of 1',
        { ...ANSWERS.business, registrationNumber: 'A' },
        'registrationNumber',
      ],
      [
        'business',
        'registrationNumber of 51',
        { ...ANSWERS.business, registrationNumber: 'A'.repeat(51) },
        'registrationNumber',
      ],
      [
        'tax',
        'vatRegistered not boolean',
        { vatRegistered: 'yes', vatNumber: null },
        'vatRegistered',
      ],
      [
        'tax',
        'vatNumber of 21',
        { vatRegistered: true, vatNumber: 'D'.repeat(21) },
        'vatNumber',
      ],
      [
        'catalog',
        'no categories',
        { ...ANSWERS.catalog, categories: [] },
        'categories',
      ],
      [
        'catalog',
        '11 categories',
        {
          ...ANSWERS.catalog,
          categories: Array.from({ length: 11 }, (_, i) => `Cat ${i}`),
        },
        'categories',
      ],
      [
        'catalog',
        'category of 1',
        { ...ANSWERS.catalog, categories: ['A'] },
        'categories.0',
      ],
      [
        'catalog',
        'category of 61',
        { ...ANSWERS.catalog, categories: ['A'.repeat(61)] },
        'categories.0',
      ],
      [
        'catalog',
        'expectedMonthlyOrders outside the four',
        { ...ANSWERS.catalog, expectedMonthlyOrders: 'LOTS' },
        'expectedMonthlyOrders',
      ],
      [
        'policies',
        'returnsDays 13',
        { ...ANSWERS.policies, returnsDays: 13 },
        'returnsDays',
      ],
      [
        'policies',
        'returnsDays 366',
        { ...ANSWERS.policies, returnsDays: 366 },
        'returnsDays',
      ],
      [
        'policies',
        'returnsDays 14.5',
        { ...ANSWERS.policies, returnsDays: 14.5 },
        'returnsDays',
      ],
      [
        'policies',
        'shipsFrom outside the EU list',
        { ...ANSWERS.policies, shipsFrom: 'US' },
        'shipsFrom',
      ],
      ['nope', 'unknown step name', ANSWERS.business, 'step'],
    ];
    it.each(cases)(
      '%s: %s → 400 naming the field, draft unchanged',
      async (stepName, _label, body, path) => {
        const s = await t.seller();
        const res = await step(s, stepName, body).expect(400);
        const problem = expectContract(onboardingProblemSchema, res.body);
        expect(problem.code).toBe('validation_failed');
        expect(problem.errors).toEqual(
          expect.arrayContaining([{ path, message: expect.any(String) }]),
        );
        expect(await redis().exists(draftKey(s.shopId))).toBe(0);
      },
    );
  });

  it('S04 AS-03: steps are independent, the lifetime slides, same-step saves last-wins, an expired draft is empty', async () => {
    const s = await t.seller();
    await step(s, 'business', ANSWERS.business).expect(200);
    await step(s, 'catalog', ANSWERS.catalog).expect(200);
    await redis().expire(draftKey(s.shopId), 100);
    await step(s, 'business', {
      ...ANSWERS.business,
      businessName: 'Second Name',
    }).expect(200);
    expect(await redis().ttl(draftKey(s.shopId))).toBeGreaterThan(
      7 * 86_400 - 10,
    );
    let body = expectContract(
      onboardingViewSchema,
      (await view(s).expect(200)).body,
    );
    expect(body.answers.catalog).toEqual(ANSWERS.catalog);
    expect(body.answers.business?.businessName).toBe('Second Name');

    // simultaneous saves of different steps both land
    const s2 = await t.seller();
    await Promise.all([
      step(s2, 'tax', ANSWERS.tax).expect(200),
      step(s2, 'policies', ANSWERS.policies).expect(200),
      step(s2, 'business', ANSWERS.business).expect(200),
      step(s2, 'catalog', ANSWERS.catalog).expect(200),
    ]);
    body = expectContract(
      onboardingViewSchema,
      (await view(s2).expect(200)).body,
    );
    expect(body.missingSteps).toEqual([]);
    expect(Object.keys(body.answers).sort()).toEqual([
      'business',
      'catalog',
      'policies',
      'tax',
    ]);

    // expiry = the key is gone
    await redis().del(draftKey(s2.shopId));
    body = expectContract(
      onboardingViewSchema,
      (await view(s2).expect(200)).body,
    );
    expect(body).toMatchObject({
      status: 'NOT_STARTED',
      answers: {},
      missingSteps: ['business', 'tax', 'catalog', 'policies'],
    });
    expect(await applicationRows(s2.shopId)).toEqual([]);
  });

  describe('S04 AS-04: submit refused, nothing persisted, draft kept', () => {
    const complete = async (
      tax: { vatRegistered: boolean; vatNumber: string | null },
      country = 'DE',
    ) => {
      const s = await t.seller();
      await t.saveSteps(s, {
        ...ANSWERS,
        business: { ...ANSWERS.business, country },
        tax,
      });
      return s;
    };
    const rejected = async (s: Seller, path?: string) => {
      const res = await submit(s).expect(400);
      const problem = expectContract(onboardingProblemSchema, res.body);
      expect(problem.code).toBe('validation_failed');
      if (path)
        expect(problem.errors).toEqual(
          expect.arrayContaining([{ path, message: expect.any(String) }]),
        );
      expect(await applicationRows(s.shopId)).toEqual([]);
      expect(await t.outbox(s.shopId)).toEqual([]);
      expect(await redis().exists(draftKey(s.shopId))).toBe(1);
      return res.body;
    };

    it('a step is missing: lists missingSteps', async () => {
      const s = await t.seller();
      await step(s, 'business', ANSWERS.business).expect(200);
      const body = await rejected(s);
      expect(body.missingSteps).toEqual(['tax', 'catalog', 'policies']);
    });
    it('VAT registered without a number', async () =>
      rejected(
        await complete({ vatRegistered: true, vatNumber: null }),
        'tax.vatNumber',
      ));
    it('a VAT number without VAT registration', async () =>
      rejected(
        await complete({ vatRegistered: false, vatNumber: 'DE136695976' }),
        'tax.vatNumber',
      ));
    it('a VAT number invalid for the business country', async () =>
      rejected(
        await complete({ vatRegistered: true, vatNumber: 'DE136695975' }),
        'tax.vatNumber',
      ));
    it('a German VAT number for a Dutch business', async () =>
      rejected(
        await complete({ vatRegistered: true, vatNumber: 'DE136695976' }, 'NL'),
        'tax.vatNumber',
      ));
  });

  it('S04 AS-05: submit writes the row, one event, drops the draft and writes no shop column', async () => {
    const s = await t.seller();
    await t.saveSteps(s, WITH_VAT);
    const [shopBefore] = await t.rows<{
      verificationStatus: string;
      payoutsEnabled: boolean;
      updatedAt: Date;
    }>(
      `SELECT "verificationStatus", "payoutsEnabled", "updatedAt" FROM "Shop" WHERE id = :id`,
      { id: s.shopId },
    );

    const res = await submit(s).expect(200);
    expect(expectContract(onboardingSubmitResultSchema, res.body)).toEqual({
      submitted: true,
      submissionNo: 1,
      requiredDocuments: [
        'BUSINESS_REGISTRATION',
        'BANK_STATEMENT',
        'VAT_CERTIFICATE',
      ],
    });
    expect(await applicationRows(s.shopId)).toEqual([
      { status: 'SUBMITTED', submissionNo: 1, submittedBy: s.id },
    ]);
    const submitted = await events(s.shopId, 'shop.onboarding_submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].payload).toMatchObject({
      payload: {
        shopId: s.shopId,
        submissionNo: 1,
        country: 'DE',
        legalForm: 'LIMITED_COMPANY',
        requiredDocuments: [
          'BUSINESS_REGISTRATION',
          'BANK_STATEMENT',
          'VAT_CERTIFICATE',
        ],
      },
    });
    expect(submitted[0].topic).toBe('shops.events');
    expect(await redis().exists(draftKey(s.shopId))).toBe(0);
    const [shopAfter] = await t.rows<{
      verificationStatus: string;
      payoutsEnabled: boolean;
      updatedAt: Date;
    }>(
      `SELECT "verificationStatus", "payoutsEnabled", "updatedAt" FROM "Shop" WHERE id = :id`,
      { id: s.shopId },
    );
    expect(shopAfter).toEqual(shopBefore);
    const history = await t.rows<{
      fromStatus: string | null;
      toStatus: string;
    }>(
      `SELECT "fromStatus", "toStatus" FROM "OnboardingStatusHistory" WHERE "entityId" = :id`,
      { id: s.shopId },
    );
    expect(history).toEqual([{ fromStatus: null, toStatus: 'SUBMITTED' }]);
  });

  it('S04 AS-05: without VAT registration two documents are required', async () => {
    const s = await t.submitted();
    const body = expectContract(
      onboardingViewSchema,
      (await view(s).expect(200)).body,
    );
    expect(body.requiredDocuments).toEqual([
      { kind: 'BUSINESS_REGISTRATION', status: 'MISSING' },
      { kind: 'BANK_STATEMENT', status: 'MISSING' },
    ]);
  });

  it('S04 AS-06: repeated, racing and late submits all answer the same body; one row, one event', async () => {
    // 20 repetitions, a fresh shop each (SC-002)
    for (let i = 0; i < 20; i++) {
      const s = await t.seller();
      await t.saveSteps(s);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => submit(s)),
      );
      for (const r of results) expect(r.status).toBe(200);
      const first = results[0].body;
      expect(
        expectContract(onboardingSubmitResultSchema, first).submissionNo,
      ).toBe(1);
      for (const r of results) expect(r.body).toEqual(first);
      expect(await applicationRows(s.shopId)).toHaveLength(1);
      expect(await events(s.shopId, 'shop.onboarding_submitted')).toHaveLength(
        1,
      );
      // after the draft is gone, a late submit still answers the stored outcome
      expect((await submit(s).expect(200)).body).toEqual(first);
    }
  }, 120_000);

  it('S04 AS-07: no step can be saved while the application is SUBMITTED or VERIFIED', async () => {
    const s = await t.submitted();
    for (const status of ['SUBMITTED', 'VERIFIED']) {
      await t.db.query(
        `UPDATE "ShopOnboarding" SET status = '${status}' WHERE "shopId" = '${s.shopId}'`,
      );
      const res = await step(s, 'policies', ANSWERS.policies).expect(409);
      expect(expectContract(onboardingProblemSchema, res.body).code).toBe(
        'already_submitted',
      );
      expect(await redis().exists(draftKey(s.shopId))).toBe(0);
    }
  });

  describe('S04 AS-08: access', () => {
    const routes = (
      shopId: string,
    ): Array<[string, 'put' | 'get' | 'post', string, object?]> => [
      [
        'save step',
        'put',
        `/api/shops/${shopId}/onboarding/steps/business`,
        ANSWERS.business,
      ],
      ['view', 'get', `/api/shops/${shopId}/onboarding`],
      ['submit', 'post', `/api/shops/${shopId}/onboarding/submit`],
    ];
    const call = (
      auth: Record<string, string> | null,
      [, method, url, body]: ReturnType<typeof routes>[number],
    ) => {
      const req = t.http()[method](url);
      if (auth) req.set(auth);
      return body ? req.send(body) : req;
    };

    it('401 without credentials', async () => {
      const s = await t.seller();
      for (const route of routes(s.shopId)) {
        const res = await call(null, route).expect(401);
        expect(expectContract(onboardingProblemSchema, res.body).code).toBe(
          'invalid_token',
        );
      }
    });

    it('404 shop_not_found for another shop, an unknown shop and a malformed id: the same body', async () => {
      const a = await t.seller();
      const b = await t.seller();
      await step(a, 'business', ANSWERS.business).expect(200);
      const bodies: unknown[] = [];
      for (const target of [a.shopId, v4(), 'not-a-uuid']) {
        for (const route of routes(target)) {
          const res = await call(b.auth, route).expect(404);
          const problem = expectContract(onboardingProblemSchema, res.body);
          expect(problem.code).toBe('shop_not_found');
          bodies.push({
            code: problem.code,
            title: problem.title,
            detail: problem.detail,
          });
        }
      }
      expect(new Set(bodies.map((x) => JSON.stringify(x))).size).toBe(1);
      // shop A's draft is neither visible nor writable from B
      const mine = expectContract(
        onboardingViewSchema,
        (await view(b).expect(200)).body,
      );
      expect(mine.status).toBe('NOT_STARTED');
      expect(Object.keys(await redis().hgetall(draftKey(b.shopId)))).toEqual(
        [],
      );
    });

    it('403 permission_denied for staff and viewers', async () => {
      const s = await t.seller();
      for (const role of ['STAFF', 'VIEWER'] as const) {
        const m = await t.member(s.shopId, role);
        for (const route of routes(s.shopId)) {
          const res = await call(m.auth, route).expect(403);
          expect(expectContract(onboardingProblemSchema, res.body).code).toBe(
            'permission_denied',
          );
        }
      }
      expect(await redis().exists(draftKey(s.shopId))).toBe(0);
    });

    it('an ADMIN of the shop may answer', async () => {
      const s = await t.seller();
      const admin = await t.member(s.shopId, 'ADMIN');
      await t
        .http()
        .put(`/api/shops/${s.shopId}/onboarding/steps/business`)
        .set(admin.auth)
        .send(ANSWERS.business)
        .expect(200);
    });

    it('the shop gate answers for a suspended and a closing shop', async () => {
      const owner = await t.user();
      const suspended = await createShop(t.app, owner, { status: 'SUSPENDED' });
      const closing = await createShop(t.app, owner, { status: 'DELETING' });
      const asSeller = (shopId: string): Seller => ({ ...owner, shopId });
      const a = await step(
        asSeller(suspended.id),
        'business',
        ANSWERS.business,
      ).expect(403);
      expect(expectContract(onboardingProblemSchema, a.body).code).toBe(
        'shop_suspended',
      );
      const b = await step(
        asSeller(closing.id),
        'business',
        ANSWERS.business,
      ).expect(409);
      expect(expectContract(onboardingProblemSchema, b.body).code).toBe(
        'shop_offboarding',
      );
    });
  });

  describe('S04 AS-09: the view in every state', () => {
    it('NOT_STARTED, DRAFT, SUBMITTED, VERIFIED and REJECTED all parse with the contract', async () => {
      const s = await t.seller();
      const states: string[] = [];
      const read = async () => {
        const body = expectContract(
          onboardingViewSchema,
          (await view(s).expect(200)).body,
        );
        states.push(body.status);
        return body;
      };
      expect((await read()).submissionNo).toBeNull();
      await step(s, 'business', ANSWERS.business).expect(200);
      expect((await read()).missingSteps).toHaveLength(3);
      await t.saveSteps(s);
      await submit(s).expect(200);
      const submitted = await read();
      expect(submitted).toMatchObject({ submissionNo: 1, missingSteps: [] });
      expect(submitted.answers).toEqual(ANSWERS);
      await t.db.query(
        `UPDATE "ShopOnboarding" SET status = 'VERIFIED' WHERE "shopId" = '${s.shopId}'`,
      );
      await read();
      await t.db.query(
        `UPDATE "ShopOnboarding" SET status = 'REJECTED' WHERE "shopId" = '${s.shopId}'`,
      );
      await read();
      expect(states).toEqual([
        'NOT_STARTED',
        'DRAFT',
        'SUBMITTED',
        'VERIFIED',
        'REJECTED',
      ]);
    });
  });

  describe('S04 AS-56 / AS-57: resubmission after a rejection', () => {
    const reject = (shopId: string) =>
      t.db.query(
        `UPDATE "ShopOnboarding" SET status = 'REJECTED', "rejectedAt" = now(), "rejectionReasonCode" = 'OTHER', "rejectionReason" = 'not clear' WHERE "shopId" = '${shopId}'`,
      );

    it('AS-56: the first save seeds the draft from the last answers; submit starts round 2 with a new event', async () => {
      const s = await t.submitted(WITH_VAT);
      await reject(s.shopId);
      expect(await redis().exists(draftKey(s.shopId))).toBe(0);

      const res = await step(s, 'business', {
        ...ANSWERS.business,
        businessName: 'Renamed Handels',
      }).expect(200);
      const body = expectContract(onboardingViewSchema, res.body);
      expect(body.status).toBe('REJECTED');
      expect(body.answers.business?.businessName).toBe('Renamed Handels');
      expect(body.answers.tax).toEqual(WITH_VAT.tax);
      expect(body.missingSteps).toEqual([]);

      const result = await submit(s).expect(200);
      expect(
        expectContract(onboardingSubmitResultSchema, result.body).submissionNo,
      ).toBe(2);
      expect(await applicationRows(s.shopId)).toEqual([
        { status: 'SUBMITTED', submissionNo: 2, submittedBy: s.id },
      ]);
      const submitted = await events(s.shopId, 'shop.onboarding_submitted');
      expect(
        submitted.map(
          (e) =>
            (e.payload as { payload: { submissionNo: number } }).payload
              .submissionNo,
        ),
      ).toEqual([1, 2]);
      const [answers] = await t.rows<{ answers: typeof ANSWERS }>(
        `SELECT answers FROM "ShopOnboarding" WHERE "shopId" = :id`,
        { id: s.shopId },
      );
      expect(answers.answers.business.businessName).toBe('Renamed Handels');
      expect(await redis().exists(draftKey(s.shopId))).toBe(0);
    });

    it("AS-56: the previous round's documents are superseded", async () => {
      const s = await t.submitted();
      const doc = await t.upload(
        s,
        'BANK_STATEMENT',
        t.pdf('statement round 1'),
      );
      await reject(s.shopId);
      await step(s, 'policies', ANSWERS.policies).expect(200);
      await submit(s).expect(200);
      expect(await t.docStatus(doc.id)).toBe('SUPERSEDED');
      const body = expectContract(
        onboardingViewSchema,
        (await view(s).expect(200)).body,
      );
      expect(body.documents).toEqual([]);
      expect(body.submissionNo).toBe(2);
    });

    it('AS-57: the same file is accepted in round 2 as a new document', async () => {
      const s = await t.submitted();
      const bytes = t.pdf('same file');
      const first = await t.upload(s, 'BANK_STATEMENT', bytes);
      await reject(s.shopId);
      await step(s, 'policies', ANSWERS.policies).expect(200);
      await submit(s).expect(200);
      const second = await t.upload(s, 'BANK_STATEMENT', bytes);
      expect(second.deduplicated).toBe(false);
      expect(second.id).not.toBe(first.id);
    });

    it('AS-57: concurrent resubmissions produce one round', async () => {
      const s = await t.submitted();
      await reject(s.shopId);
      await step(s, 'policies', ANSWERS.policies).expect(200);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => submit(s)),
      );
      for (const r of results) expect(r.status).toBe(200);
      for (const r of results) expect(r.body.submissionNo).toBe(2);
      expect((await applicationRows(s.shopId))[0].submissionNo).toBe(2);
      expect(await events(s.shopId, 'shop.onboarding_submitted')).toHaveLength(
        2,
      );
    });
  });
});
