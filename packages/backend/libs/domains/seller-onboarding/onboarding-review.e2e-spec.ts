import { Logger } from '@nestjs/common';
import { v4 } from 'uuid';
import {
  onboardingProblemSchema,
  onboardingViewSchema,
  reviewQueuePageSchema,
  reviewResolveResultSchema,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { Role, SecretBox } from '@app/domains/identity';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import {
  BAD_IBAN,
  bankAnswer,
  createOnboardingApp,
  expectContract,
  GOOD_IBAN,
  WITH_VAT,
  type OnboardingTestApp,
  type Seller,
  type TestUser,
} from './testing/onboarding-app';

describe('Seller onboarding: human review (e2e)', () => {
  let t: OnboardingTestApp;
  let moderator: TestUser;
  const queue = (as: TestUser, query = '') =>
    t.http().get(`/api/admin/onboarding/reviews${query}`).set(as.auth);
  const resolve = (as: TestUser, taskId: string, body: object) =>
    t
      .http()
      .post(`/api/admin/onboarding/reviews/${taskId}/resolve`)
      .set(as.auth)
      .send(body);
  const problem = (body: unknown) =>
    expectContract(onboardingProblemSchema, body);
  const taskRow = async (id: string) =>
    (
      await t.rows<{
        status: string;
        corrections: unknown;
        resolvedBy: string | null;
        resolvedAt: Date | null;
      }>(
        `SELECT status, corrections, "resolvedBy", "resolvedAt" FROM "ReviewTask" WHERE id = :id`,
        { id },
      )
    )[0];
  const attempts = (documentId: string) =>
    t.rows<{
      attempt: number;
      model: string;
      outcome: string;
      sealedFields: string;
      fields: unknown;
    }>(
      `SELECT attempt, model, outcome, "sealedFields", fields FROM "DocumentExtraction" WHERE "documentId" = :documentId ORDER BY attempt`,
      { documentId },
    );
  const events = async (shopId: string, type: string) =>
    (await t.outbox(shopId)).filter((r) => r.type === type);
  /** A statement with a valid IBAN whose holder does not match: waits for review, passes every hard check. */
  const needsReviewValid = async (s: Seller) => {
    const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf(`valid ${v4()}`));
    t.llm.script({ text: bankAnswer(GOOD_IBAN, 'high', 'Another Holder Ltd') });
    await t.extraction.process(doc.id);
    const [task] = await t.rows<{ id: string }>(
      `SELECT id FROM "ReviewTask" WHERE "documentId" = :id`,
      { id: doc.id },
    );
    return { documentId: doc.id, taskId: task.id };
  };
  const counter = (name: string, labels: Record<string, string>) =>
    MetricsRegistry.value(name, labels) ?? 0;

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

  describe('S04 AS-37: the queue', () => {
    it('lists open tasks oldest first with masked values, a 300 s link and the shop name', async () => {
      const a = await t.submitted();
      const b = await t.submitted();
      const first = await t.needsReview(a);
      const second = await t.needsReview(b, 'BANK_STATEMENT');
      const res = await queue(moderator).expect(200);
      const page = expectContract(reviewQueuePageSchema, res.body);
      expect(page.nextCursor).toBeNull();
      expect(page.items.map((i) => i.id)).toEqual([
        first.taskId,
        second.taskId,
      ]);
      const item = page.items[0];
      expect(item).toMatchObject({
        documentId: first.documentId,
        shopId: a.shopId,
        shopName: 'Müller Handels',
        kind: 'BANK_STATEMENT',
        reasons: [{ field: 'iban', code: 'iban_checksum', escalate: true }],
        attempts: 2,
      });
      expect(item.model).toContain('opus');
      expect(item.fields.iban.value).toBe('DE89 •••• 3001');
      expect(item.fileUrl).toMatch(/X-Amz-Expires=300/);
      expect(JSON.stringify(res.body)).not.toContain('0532');
      expect(JSON.stringify(res.body)).not.toContain('3704');
    });

    it('has no link once the raw file was purged; a null shop name when tenancy does not know the shop', async () => {
      const a = await t.submitted();
      const { documentId } = await t.needsReview(a);
      await t.db.query(
        `UPDATE "ShopDocument" SET "purgedAt" = now() WHERE id = '${documentId}'`,
      );
      const page = expectContract(
        reviewQueuePageSchema,
        (await queue(moderator).expect(200)).body,
      );
      expect(page.items[0].fileUrl).toBeNull();
    });

    it('filters by kind and omits superseded and cancelled documents', async () => {
      const s = await t.submitted(WITH_VAT);
      const bank = await t.needsReview(s, 'BANK_STATEMENT');
      const reg = await t.needsReview(s, 'BUSINESS_REGISTRATION');
      const vat = await t.needsReview(s, 'VAT_CERTIFICATE');
      const ids = async (q = '') =>
        expectContract(
          reviewQueuePageSchema,
          (await queue(moderator, q).expect(200)).body,
        ).items.map((i) => i.id);
      expect((await ids()).sort()).toEqual(
        [bank.taskId, reg.taskId, vat.taskId].sort(),
      );
      expect(await ids('?kind=BANK_STATEMENT')).toEqual([bank.taskId]);
      expect(await ids('?kind=VAT_CERTIFICATE')).toEqual([vat.taskId]);
      await t.upload(s, 'BANK_STATEMENT', t.pdf('replacement')); // supersedes the waiting statement
      await t.db.query(
        `UPDATE "ReviewTask" SET status = 'CANCELLED' WHERE id = '${reg.taskId}'`,
      );
      expect(await ids()).toEqual([vat.taskId]);
    });
  });

  it('S04 AS-38: 120 tasks page by (createdAt, id) without gaps or repeats; bad limit and tampered cursor are 400', async () => {
    const owner = await t.user();
    const shops = await Promise.all(
      [1, 2, 3].map(() => createShop(t.app, owner)),
    );
    for (const [i, shop] of shops.entries()) {
      await t.db.query(
        `INSERT INTO "ShopDocument" (id, "shopId", kind, "contentType", "contentHash", "storageKey", status)
         SELECT uuidv7(), '${shop.id}', 'BANK_STATEMENT', 'application/pdf', md5(random()::text || g::text) || md5(g::text), 'kyc/${shop.id}/' || g, 'NEEDS_REVIEW'
           FROM generate_series(1, 40) g`,
      );
      // three distinct instants, so the (createdAt, id) tiebreak is exercised
      await t.db.query(
        `INSERT INTO "ReviewTask" ("documentId", "shopId", reasons, "createdAt")
         SELECT id, "shopId", '[]', timestamptz '2026-01-01 00:00:00+00' + interval '${i} minute' FROM "ShopDocument" WHERE "shopId" = '${shop.id}'`,
      );
    }
    const expected = (
      await t.rows<{ id: string }>(
        `SELECT id FROM "ReviewTask" WHERE status = 'OPEN' ORDER BY "createdAt", id`,
      )
    ).map((r) => r.id);
    expect(expected).toHaveLength(120);

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await queue(
        moderator,
        `?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
      ).expect(200);
      const page = expectContract(reviewQueuePageSchema, res.body);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);

    const def = expectContract(
      reviewQueuePageSchema,
      (await queue(moderator).expect(200)).body,
    );
    expect(def.items).toHaveLength(50);
    for (const bad of [
      '?limit=101',
      '?limit=0',
      '?limit=abc',
      '?cursor=not-a-cursor',
      `?cursor=${Buffer.from('{"c":"x","i":"y"}').toString('base64url')}`,
    ]) {
      const res = await queue(moderator, bad).expect(400);
      expect(problem(res.body).code).toBe('validation_failed');
    }
    expect(
      (await queue(moderator, '?limit=100').expect(200)).body.items,
    ).toHaveLength(100);
  }, 60_000);

  describe('S04 AS-39: access', () => {
    it('401 without credentials; 403 insufficient_role for a seller; 401 for a revoked session', async () => {
      const s = await t.seller();
      const { taskId } = await t.needsReview(await t.submitted());
      const res = await t
        .http()
        .get('/api/admin/onboarding/reviews')
        .expect(401);
      expect(problem(res.body).code).toBe('invalid_token');
      const noAuth = await t
        .http()
        .post(`/api/admin/onboarding/reviews/${taskId}/resolve`)
        .send({ decision: 'REJECT', reason: 'no way' })
        .expect(401);
      expect(problem(noAuth.body).code).toBe('invalid_token');

      for (const call of [
        queue(s),
        resolve(s, taskId, { decision: 'REJECT', reason: 'no way' }),
      ]) {
        const forbidden = await call.expect(403);
        expect(problem(forbidden.body).code).toBe('insufficient_role');
      }

      await t.app
        .get(RedisService)
        .client.set(`auth:revoked:${moderator.sessionId}`, 'test', 'EX', 60);
      const revoked = await queue(moderator).expect(401);
      expect(problem(revoked.body).code).toBe('invalid_token');
      await resolve(moderator, taskId, {
        decision: 'REJECT',
        reason: 'no way',
      }).expect(401);
      expect((await taskRow(taskId)).status).toBe('OPEN');
      await queue(await t.user(Role.ADMIN)).expect(200);
    });
  });

  it('S04 AS-40: approving as is records a human attempt, no corrections, and evaluates the verification', async () => {
    const s = await t.submitted();
    const reg = await t.approved(s, 'BUSINESS_REGISTRATION');
    expect(await t.docStatus(reg)).toBe('APPROVED');
    const { documentId, taskId } = await needsReviewValid(s);
    const res = await resolve(moderator, taskId, {
      decision: 'APPROVE',
    }).expect(200);
    expect(expectContract(reviewResolveResultSchema, res.body)).toEqual({
      status: 'APPROVED',
      shopVerified: true,
    });
    const task = await taskRow(taskId);
    expect(task).toMatchObject({
      status: 'APPROVED',
      corrections: {},
      resolvedBy: moderator.id,
    });
    expect(task.resolvedAt).not.toBeNull();
    expect(await t.docStatus(documentId)).toBe('APPROVED');
    const rows = await attempts(documentId);
    expect(rows.at(-1)).toMatchObject({ model: 'human', outcome: 'ACCEPTED' });
    expect(await events(s.shopId, 'shop.verified')).toHaveLength(1);
  });

  it('S04 AS-41: corrections are stored as masked pairs, the sealed row holds the corrected value, counters rise per changed field', async () => {
    const s = await t.submitted();
    const { documentId, taskId } = await t.needsReview(s);
    const before = counter('kyc_field_corrections_total', {
      kind: 'BANK_STATEMENT',
      field: 'iban',
    });
    const res = await resolve(moderator, taskId, {
      decision: 'APPROVE',
      corrections: { iban: GOOD_IBAN },
    }).expect(200);
    expectContract(reviewResolveResultSchema, res.body);
    expect((await taskRow(taskId)).corrections).toEqual({
      iban: { extracted: 'DE89 •••• 3001', corrected: 'DE89 •••• 3000' },
    });
    const final = (await attempts(documentId)).at(-1)!;
    expect(final.model).toBe('human');
    const opened = JSON.parse(
      t.app
        .get(SecretBox, { strict: false })
        .open(final.sealedFields, `kyc:${documentId}:${final.attempt}`),
    );
    expect(opened.fields.iban.value).toBe(GOOD_IBAN);
    expect(JSON.stringify(final.fields)).not.toContain('3704');
    expect(
      counter('kyc_field_corrections_total', {
        kind: 'BANK_STATEMENT',
        field: 'iban',
      }),
    ).toBe(before + 1);
  });

  it('S04 AS-41: a correction equal to the extracted value is not recorded', async () => {
    const s = await t.submitted();
    const { taskId } = await needsReviewValid(s);
    await resolve(moderator, taskId, {
      decision: 'APPROVE',
      corrections: {
        bankName: 'Commerzbank',
        accountHolder: 'Müller Handels GmbH',
      },
    }).expect(200);
    expect((await taskRow(taskId)).corrections).toEqual({
      accountHolder: {
        extracted: 'Another Holder Ltd',
        corrected: 'Müller Handels GmbH',
      },
    });
  });

  describe('S04 AS-42: hard checks, key fields, correction shape', () => {
    const refused = async (
      taskId: string,
      documentId: string,
      body: object,
      status: number,
      code: string,
    ) => {
      const res = await resolve(moderator, taskId, body).expect(status);
      expect(problem(res.body).code).toBe(code);
      expect((await taskRow(taskId)).status).toBe('OPEN');
      expect(await t.docStatus(documentId)).toBe('NEEDS_REVIEW');
      expect(
        (await attempts(documentId)).some((a) => a.model === 'human'),
      ).toBe(false);
    };

    it('422 iban_invalid for a statement whose IBAN still fails the checksum', async () => {
      const { documentId, taskId } = await t.needsReview(await t.submitted());
      await refused(
        taskId,
        documentId,
        { decision: 'APPROVE' },
        422,
        'iban_invalid',
      );
      await refused(
        taskId,
        documentId,
        { decision: 'APPROVE', corrections: { iban: BAD_IBAN } },
        422,
        'iban_invalid',
      );
    });
    it('422 vat_invalid for a certificate whose VAT number fails', async () => {
      const { documentId, taskId } = await t.needsReview(
        await t.submitted(WITH_VAT),
        'VAT_CERTIFICATE',
      );
      await refused(
        taskId,
        documentId,
        { decision: 'APPROVE' },
        422,
        'vat_invalid',
      );
      await refused(
        taskId,
        documentId,
        {
          decision: 'APPROVE',
          corrections: { vatNumber: 'DE136695976', country: 'FR' },
        },
        422,
        'vat_invalid',
      );
    });
    it('422 missing_fields for an empty key field, fixed by a correction', async () => {
      const s = await t.submitted();
      const { documentId, taskId } = await t.needsReview(
        s,
        'BUSINESS_REGISTRATION',
      );
      await refused(
        taskId,
        documentId,
        { decision: 'APPROVE' },
        422,
        'missing_fields',
      );
      await resolve(moderator, taskId, {
        decision: 'APPROVE',
        corrections: { registrationNumber: 'HRB12345' },
      }).expect(200);
    });
    it.each([
      ['a field the kind does not have', { legalName: 'X' }],
      ['a field no kind has', { password: 'x' }],
      ['a value of 501 characters', { bankName: 'x'.repeat(501) }],
      ['an empty value', { bankName: '' }],
    ])('400 validation_failed for %s', async (_label, corrections) => {
      const { documentId, taskId } = await t.needsReview(await t.submitted());
      await refused(
        taskId,
        documentId,
        { decision: 'APPROVE', corrections },
        400,
        'validation_failed',
      );
    });
    it('400 validation_failed for an unknown decision or an extra key', async () => {
      const { documentId, taskId } = await t.needsReview(await t.submitted());
      await refused(
        taskId,
        documentId,
        { decision: 'MAYBE' },
        400,
        'validation_failed',
      );
      await refused(
        taskId,
        documentId,
        { decision: 'APPROVE', reason: 'not allowed here' },
        400,
        'validation_failed',
      );
    });
  });

  describe('S04 AS-43: rejecting a document', () => {
    it('stores the reason, publishes the event and shows the reason to the seller, who may upload again', async () => {
      const s = await t.submitted();
      const { documentId, taskId } = await t.needsReview(s);
      const res = await resolve(moderator, taskId, {
        decision: 'REJECT',
        reason: 'Statement is cropped',
      }).expect(200);
      expect(expectContract(reviewResolveResultSchema, res.body)).toEqual({
        status: 'REJECTED',
        shopVerified: false,
      });
      expect((await taskRow(taskId)).status).toBe('REJECTED');
      expect(await t.docStatus(documentId)).toBe('REJECTED');
      const rejected = await events(
        s.shopId,
        'shop.onboarding_document_rejected',
      );
      expect(rejected).toHaveLength(1);
      expect(rejected[0].payload).toMatchObject({
        payload: {
          shopId: s.shopId,
          documentId,
          kind: 'BANK_STATEMENT',
          reason: 'Statement is cropped',
        },
      });
      const view = expectContract(
        onboardingViewSchema,
        (
          await t
            .http()
            .get(`/api/shops/${s.shopId}/onboarding`)
            .set(s.auth)
            .expect(200)
        ).body,
      );
      expect(view.documents).toEqual([
        {
          id: documentId,
          kind: 'BANK_STATEMENT',
          status: 'REJECTED',
          rejectionReason: 'Statement is cropped',
        },
      ]);
      await t.upload(s, 'BANK_STATEMENT', t.pdf('a better scan'));
    });

    it.each([
      ['no reason', {}],
      ['a reason of 2 characters', { reason: 'no' }],
      ['a reason of 501 characters', { reason: 'x'.repeat(501) }],
    ])(
      '400 validation_failed for %s; nothing changes',
      async (_label, extra) => {
        const s = await t.submitted();
        const { documentId, taskId } = await t.needsReview(s);
        const res = await resolve(moderator, taskId, {
          decision: 'REJECT',
          ...extra,
        }).expect(400);
        expect(problem(res.body).code).toBe('validation_failed');
        expect((await taskRow(taskId)).status).toBe('OPEN');
        expect(await t.docStatus(documentId)).toBe('NEEDS_REVIEW');
        expect(
          await events(s.shopId, 'shop.onboarding_document_rejected'),
        ).toEqual([]);
      },
    );
  });

  it('S04 AS-44: two reviewers at the same moment - one winner, one final row, one decision counted', async () => {
    const s = await t.submitted();
    const reg = await t.approved(s, 'BUSINESS_REGISTRATION');
    expect(await t.docStatus(reg)).toBe('APPROVED');
    const { documentId, taskId } = await needsReviewValid(s);
    const other = await t.user(Role.ADMIN);
    const before = counter('kyc_review_decisions_total', {
      kind: 'BANK_STATEMENT',
      decision: 'APPROVED',
    });
    const results = await Promise.all([
      resolve(moderator, taskId, { decision: 'APPROVE' }),
      resolve(other, taskId, { decision: 'APPROVE' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(problem(loser.body).code).toBe('task_already_resolved');
    expect(
      (await attempts(documentId)).filter((a) => a.model === 'human'),
    ).toHaveLength(1);
    expect(
      counter('kyc_review_decisions_total', {
        kind: 'BANK_STATEMENT',
        decision: 'APPROVED',
      }),
    ).toBe(before + 1);
    expect(await events(s.shopId, 'shop.verified')).toHaveLength(1);
  });

  describe('S04 AS-45: stale, resolved, unknown and malformed tasks', () => {
    it('a task whose document was superseded is 409 document_superseded', async () => {
      const s = await t.submitted();
      const { taskId } = await t.needsReview(s);
      await t.db.query(
        `UPDATE "ShopDocument" SET status = 'SUPERSEDED' WHERE id = (SELECT "documentId" FROM "ReviewTask" WHERE id = '${taskId}')`,
      );
      const res = await resolve(moderator, taskId, {
        decision: 'REJECT',
        reason: 'too late',
      }).expect(409);
      expect(problem(res.body).code).toBe('document_superseded');
      expect((await taskRow(taskId)).status).toBe('OPEN');
    });
    it('a task cancelled with its document is 409 document_superseded', async () => {
      const s = await t.submitted();
      const { taskId } = await t.needsReview(s);
      await t.upload(s, 'BANK_STATEMENT', t.pdf('replacement'));
      const res = await resolve(moderator, taskId, {
        decision: 'REJECT',
        reason: 'too late',
      }).expect(409);
      expect(problem(res.body).code).toBe('document_superseded');
    });
    it('a resolved task is 409 task_already_resolved', async () => {
      const { taskId } = await t.needsReview(await t.submitted());
      await resolve(moderator, taskId, {
        decision: 'REJECT',
        reason: 'first',
      }).expect(200);
      const res = await resolve(moderator, taskId, {
        decision: 'REJECT',
        reason: 'second',
      }).expect(409);
      expect(problem(res.body).code).toBe('task_already_resolved');
    });
    it('an unknown task is 404 review_task_not_found; a malformed id is 400 validation_failed', async () => {
      const unknown = await resolve(moderator, v4(), {
        decision: 'REJECT',
        reason: 'nobody',
      }).expect(404);
      expect(problem(unknown.body).code).toBe('review_task_not_found');
      const malformed = await resolve(moderator, 'not-a-uuid', {
        decision: 'REJECT',
        reason: 'nobody',
      }).expect(400);
      expect(problem(malformed.body).code).toBe('validation_failed');
    });
  });

  describe('S04 AS-46: rejecting the application', () => {
    it('rejects, cancels every open task of the shop, emits shop.rejected and schedules the purge', async () => {
      const s = await t.submitted(WITH_VAT);
      const first = await t.needsReview(s, 'BANK_STATEMENT');
      const second = await t.needsReview(s, 'VAT_CERTIFICATE');
      const res = await resolve(moderator, first.taskId, {
        decision: 'REJECT_APPLICATION',
        reasonCode: 'DOCUMENTS_INVALID',
        reason: 'Documents do not belong to this business',
      }).expect(200);
      expect(expectContract(reviewResolveResultSchema, res.body)).toEqual({
        status: 'APPLICATION_REJECTED',
        shopVerified: false,
      });
      const [application] = await t.rows<{
        status: string;
        rejectionReasonCode: string;
        rejectedAt: Date;
      }>(
        `SELECT status, "rejectionReasonCode", "rejectedAt" FROM "ShopOnboarding" WHERE "shopId" = :id`,
        { id: s.shopId },
      );
      expect(application).toMatchObject({
        status: 'REJECTED',
        rejectionReasonCode: 'DOCUMENTS_INVALID',
      });
      expect((await taskRow(first.taskId)).status).toBe('CANCELLED');
      expect((await taskRow(second.taskId)).status).toBe('CANCELLED');
      const rejected = await events(s.shopId, 'shop.rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].payload).toMatchObject({
        payload: {
          shopId: s.shopId,
          submissionNo: 1,
          reasonCode: 'DOCUMENTS_INVALID',
        },
      });
      expect(JSON.stringify(rejected[0].payload)).not.toContain(
        'belong to this business',
      );
      const jobs = await new JobsTestProbe(t.db).find(
        'onboarding.purge-documents',
        { shopId: s.shopId },
      );
      expect(jobs).toHaveLength(1);
      const days =
        (new Date(jobs[0].runAt).getTime() - t.clock.now().getTime()) /
        86_400_000;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThan(31);
      // a second decision on the rejected application is a refusal
      const again = await resolve(moderator, second.taskId, {
        decision: 'REJECT_APPLICATION',
        reasonCode: 'OTHER',
        reason: 'again',
      }).expect(409);
      expect(problem(again.body).code).toBe('task_already_resolved');
    });

    it('409 already_verified for a verified application', async () => {
      const s = await t.submitted();
      const { taskId } = await t.needsReview(s);
      await t.db.query(
        `UPDATE "ShopOnboarding" SET status = 'VERIFIED' WHERE "shopId" = '${s.shopId}'`,
      );
      const res = await resolve(moderator, taskId, {
        decision: 'REJECT_APPLICATION',
        reasonCode: 'FRAUD_SUSPECTED',
        reason: 'late',
      }).expect(409);
      expect(problem(res.body).code).toBe('already_verified');
      expect(await events(s.shopId, 'shop.rejected')).toEqual([]);
    });

    it.each([
      [
        'a missing reason code',
        { decision: 'REJECT_APPLICATION', reason: 'because' },
      ],
      [
        'an unknown reason code',
        {
          decision: 'REJECT_APPLICATION',
          reasonCode: 'BORED',
          reason: 'because',
        },
      ],
      [
        'a short reason',
        { decision: 'REJECT_APPLICATION', reasonCode: 'OTHER', reason: 'no' },
      ],
    ])('400 for %s', async (_label, body) => {
      const { taskId } = await t.needsReview(await t.submitted());
      await resolve(moderator, taskId, body).expect(400);
      expect((await taskRow(taskId)).status).toBe('OPEN');
    });
  });

  it('S04 AS-47: a reviewer who is a member of the shop is refused; the same reviewer may resolve other shops', async () => {
    const mine = await t.submitted();
    const theirs = await t.submitted();
    const conflicted = await t.needsReview(mine);
    const other = await t.needsReview(theirs);
    await addMember(t.app, mine.shopId, moderator.id, 'STAFF');
    const res = await resolve(moderator, conflicted.taskId, {
      decision: 'REJECT',
      reason: 'my own shop',
    }).expect(403);
    expect(problem(res.body).code).toBe('conflict_of_interest');
    expect((await taskRow(conflicted.taskId)).status).toBe('OPEN');
    expect(
      await events(mine.shopId, 'shop.onboarding_document_rejected'),
    ).toEqual([]);
    await resolve(moderator, other.taskId, {
      decision: 'REJECT',
      reason: 'somebody else',
    }).expect(200);
  });

  it('S04 AS-48: every resolve and every file link is audited with ids and codes only', async () => {
    const lines: Array<Record<string, unknown>> = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(function (
      this: { context?: string },
      message: unknown,
    ) {
      if (
        this.context === 'Audit' &&
        typeof message === 'string' &&
        message.includes('"audit":"seller-onboarding"')
      )
        lines.push(JSON.parse(message));
    });
    const s = await t.submitted();
    const a = await t.needsReview(s);
    await queue(moderator).expect(200);
    await resolve(moderator, a.taskId, { decision: 'APPROVE' }).expect(422);
    await resolve(moderator, a.taskId, {
      decision: 'REJECT',
      reason: 'secret reason text DE89 3704 0044 0532 0130 00',
    }).expect(200);
    await resolve(moderator, a.taskId, {
      decision: 'REJECT',
      reason: 'again',
    }).expect(409);

    const resolves = lines.filter((l) => l.event === 'review.resolve');
    expect(resolves.map((l) => [l.decision, l.outcome])).toEqual([
      ['APPROVE', 'iban_invalid'],
      ['REJECT', 'accepted'],
      ['REJECT', 'task_already_resolved'],
    ]);
    for (const l of resolves)
      expect(l).toMatchObject({
        audit: 'seller-onboarding',
        reviewerId: moderator.id,
        taskId: a.taskId,
        shopId: s.shopId,
      });
    expect(lines.filter((l) => l.event === 'review.file_link')).toHaveLength(1);
    const text = JSON.stringify(lines);
    for (const forbidden of [
      'secret reason',
      '3704',
      'X-Amz',
      'http://',
      'Müller',
    ])
      expect(text).not.toContain(forbidden);
  });
});
