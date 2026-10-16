import { v4 } from 'uuid';
import {
  onboardingProblemSchema,
  onboardingSubmitResultSchema,
  onboardingViewSchema,
} from '@marketplace-sandbox/contracts';
import { Role } from '@app/domains/identity';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import {
  ANSWERS,
  bankAnswer,
  createOnboardingApp,
  expectContract,
  GOOD_IBAN,
  registrationAnswer,
  type OnboardingTestApp,
  type Seller,
  type TestUser,
} from './testing/onboarding-app';

describe('Seller onboarding: verification and view (e2e)', () => {
  let t: OnboardingTestApp;
  let moderator: TestUser;
  const events = async (shopId: string, type: string) =>
    (await t.outbox(shopId)).filter((r) => r.type === type);
  const application = async (shopId: string) =>
    (
      await t.rows<{ status: string; verifiedAt: Date | null }>(
        `SELECT status, "verifiedAt" FROM "ShopOnboarding" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0];
  const shopRow = async (shopId: string) =>
    (
      await t.rows<Record<string, unknown>>(
        `SELECT * FROM "Shop" WHERE id = :shopId`,
        { shopId },
      )
    )[0];
  const resolve = (
    taskId: string,
    body: object = { decision: 'APPROVE' },
    as = moderator,
  ) =>
    t
      .http()
      .post(`/api/admin/onboarding/reviews/${taskId}/resolve`)
      .set(as.auth)
      .send(body);
  /** A statement with a valid IBAN and a non-matching holder: waits for review, approvable as is. */
  const reviewableStatement = async (s: Seller) => {
    const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf(`statement ${v4()}`));
    t.llm.script({ text: bankAnswer(GOOD_IBAN, 'high', 'Another Holder Ltd') });
    await t.extraction.process(doc.id);
    const [task] = await t.rows<{ id: string }>(
      `SELECT id FROM "ReviewTask" WHERE "documentId" = :id`,
      { id: doc.id },
    );
    return { documentId: doc.id, taskId: task.id };
  };
  const reviewableRegistration = async (s: Seller) => {
    const doc = await t.upload(
      s,
      'BUSINESS_REGISTRATION',
      t.pdf(`registration ${v4()}`),
    );
    t.llm.script({
      text: registrationAnswer({
        fields: {
          ...JSON.parse(registrationAnswer()).fields,
          legalName: {
            value: 'Different Name AG',
            confidence: 'high',
            evidence: null,
          },
        },
      }),
    });
    await t.extraction.process(doc.id);
    const [task] = await t.rows<{ id: string }>(
      `SELECT id FROM "ReviewTask" WHERE "documentId" = :id`,
      { id: doc.id },
    );
    return { documentId: doc.id, taskId: task.id };
  };
  const dropTrigger = () =>
    t.db.query(
      `DROP TRIGGER IF EXISTS s04_fail_verified ON "Outbox"; DROP FUNCTION IF EXISTS s04_fail_verified()`,
    );

  beforeAll(async () => {
    t = await createOnboardingApp();
  });
  afterAll(async () => {
    await dropTrigger();
    await t.close();
  });
  beforeEach(async () => {
    await t.seeds.clean();
    t.llm.reset();
    moderator = await t.user(Role.MODERATOR);
  });
  afterEach(dropTrigger); // L-013: a fault injected on purpose is removed before the next test

  it('S04 AS-49: the last required approval verifies in its own transaction: event, purge job, no shop write', async () => {
    const s = await t.submitted();
    const before = await shopRow(s.shopId);
    await t.approved(s, 'BUSINESS_REGISTRATION');
    expect((await application(s.shopId)).status).toBe('SUBMITTED');
    await t.approved(s, 'BANK_STATEMENT');

    const app = await application(s.shopId);
    expect(app.status).toBe('VERIFIED');
    expect(app.verifiedAt).not.toBeNull();
    const verified = await events(s.shopId, 'shop.verified');
    expect(verified).toHaveLength(1);
    expect(verified[0].payload).toMatchObject({
      payload: {
        shopId: s.shopId,
        submissionNo: 1,
        verifiedAt: app.verifiedAt!.toISOString(),
      },
    });
    const jobs = await new JobsTestProbe(t.db).find(
      'onboarding.purge-documents',
      { shopId: s.shopId },
    );
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0].runAt).getTime()).toBe(
      app.verifiedAt!.getTime() + 30 * 86_400_000,
    );
    const [key] = await t.rows<{ idempotencyKey: string }>(
      `SELECT "idempotencyKey" FROM "Job" WHERE id = :id`,
      { id: jobs[0].id },
    );
    expect(key.idempotencyKey).toBe(`purge:${s.shopId}:1`);
    expect(await shopRow(s.shopId)).toEqual(before); // tenancy changes the shop from the event
    const history = await t.rows<{ fromStatus: string; toStatus: string }>(
      `SELECT "fromStatus", "toStatus" FROM "OnboardingStatusHistory" WHERE "entityId" = :id AND entity = 'APPLICATION' ORDER BY at, id`,
      { id: s.shopId },
    );
    expect(history.map((h) => h.toStatus)).toEqual(['SUBMITTED', 'VERIFIED']);
  });

  it('S04 AS-50: partial approvals and approvals of a kind that is not required do not verify', async () => {
    const s = await t.submitted();
    await t.approved(s, 'BUSINESS_REGISTRATION');
    // an approved document of a kind the application does not require (seeded: the API refuses to create one)
    await t.db.query(
      `INSERT INTO "ShopDocument" (id, "shopId", kind, "contentType", "contentHash", "storageKey", status)
       VALUES (uuidv7(), '${s.shopId}', 'VAT_CERTIFICATE', 'application/pdf', '${'c'.repeat(64)}', 'kyc/x/vat', 'APPROVED')`,
    );
    const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf('statement'));
    t.llm.script({ text: bankAnswer(GOOD_IBAN, 'high', 'Another Holder Ltd') });
    await t.extraction.process(doc.id); // not approved: review
    expect((await application(s.shopId)).status).toBe('SUBMITTED');
    expect(await events(s.shopId, 'shop.verified')).toEqual([]);
    expect(
      await new JobsTestProbe(t.db).find('onboarding.purge-documents', {
        shopId: s.shopId,
      }),
    ).toEqual([]);
  });

  describe('S04 AS-51: the last two approvals racing', () => {
    it('one by extraction and one by a reviewer: one verification, one event, one purge job', async () => {
      const s = await t.submitted();
      const statement = await reviewableStatement(s);
      const reg = await t.upload(
        s,
        'BUSINESS_REGISTRATION',
        t.pdf('registration'),
      );
      t.llm.script({ text: registrationAnswer() });
      const results = await Promise.all([
        t.extraction.process(reg.id),
        resolve(statement.taskId),
      ]);
      expect((results[1] as { status: number }).status).toBe(200);
      expect((await application(s.shopId)).status).toBe('VERIFIED');
      expect(await events(s.shopId, 'shop.verified')).toHaveLength(1);
      expect(
        await new JobsTestProbe(t.db).find('onboarding.purge-documents', {
          shopId: s.shopId,
        }),
      ).toHaveLength(1);
    });

    it('two reviewers approving the last two documents: exactly one of the responses says shopVerified', async () => {
      const s = await t.submitted();
      const statement = await reviewableStatement(s);
      const reg = await reviewableRegistration(s);
      const other = await t.user(Role.ADMIN);
      const [a, b] = await Promise.all([
        resolve(statement.taskId),
        resolve(reg.taskId, { decision: 'APPROVE' }, other),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.shopVerified, b.body.shopVerified].sort()).toEqual([
        false,
        true,
      ]);
      expect(await events(s.shopId, 'shop.verified')).toHaveLength(1);
      expect(
        await new JobsTestProbe(t.db).find('onboarding.purge-documents', {
          shopId: s.shopId,
        }),
      ).toHaveLength(1);
    });
  });

  it('S04 AS-52: VERIFIED is final - late results, stale tasks, resubmission, requests and edits change nothing', async () => {
    const s = await t.submitted();
    const stale = await reviewableStatement(s); // a task that will be stale
    const regId = await t.approved(s, 'BUSINESS_REGISTRATION');
    const second = await t.approved(s, 'BANK_STATEMENT'); // supersedes the waiting statement and verifies
    expect((await application(s.shopId)).status).toBe('VERIFIED');
    const before = await t.outbox(s.shopId);

    t.llm.reset();
    await t.extraction.process(second); // a late/duplicate message
    await t.extraction.process(regId);
    expect(t.llm.requests).toHaveLength(0);
    const staleRes = await resolve(stale.taskId).expect(409);
    expect(expectContract(onboardingProblemSchema, staleRes.body).code).toMatch(
      /document_superseded|already_verified|task_already_resolved/,
    );
    const step = await t
      .http()
      .put(`/api/shops/${s.shopId}/onboarding/steps/policies`)
      .set(s.auth)
      .send(ANSWERS.policies)
      .expect(409);
    expect(step.body.code).toBe('already_submitted');
    const request = await t
      .http()
      .post(`/api/shops/${s.shopId}/onboarding/documents`)
      .set(s.auth)
      .send({
        kind: 'BANK_STATEMENT',
        sha256: 'e'.repeat(64),
        size: 10,
        contentType: 'application/pdf',
      })
      .expect(409);
    expect(request.body.code).toBe('already_verified');
    const again = await t
      .http()
      .post(`/api/shops/${s.shopId}/onboarding/submit`)
      .set(s.auth)
      .expect(200);
    expect(
      expectContract(onboardingSubmitResultSchema, again.body).submissionNo,
    ).toBe(1);
    await t
      .http()
      .post(`/api/admin/onboarding/reviews/${stale.taskId}/resolve`)
      .set(moderator.auth)
      .send({
        decision: 'REJECT_APPLICATION',
        reasonCode: 'OTHER',
        reason: 'too late',
      })
      .expect(409);

    expect((await application(s.shopId)).status).toBe('VERIFIED');
    expect((await t.outbox(s.shopId)).map((r) => r.id)).toEqual(
      before.map((r) => r.id),
    );
  });

  describe('S04 AS-53: an outbox failure rolls the approval back', () => {
    const failVerifiedInserts = () =>
      t.db.query(`
        CREATE FUNCTION s04_fail_verified() RETURNS trigger AS $$
        BEGIN
          IF NEW."eventName" = 'shop.verified' THEN RAISE EXCEPTION 's04 injected outbox failure'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER s04_fail_verified BEFORE INSERT ON "Outbox" FOR EACH ROW EXECUTE FUNCTION s04_fail_verified();`);

    it('extraction path: the document keeps its status, nothing is verified, the retry completes', async () => {
      const s = await t.submitted();
      await t.approved(s, 'BUSINESS_REGISTRATION');
      const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf('statement'));
      await failVerifiedInserts();
      t.llm.script({ text: bankAnswer(GOOD_IBAN) });
      await expect(t.extraction.process(doc.id)).rejects.toThrow();
      expect(await t.docStatus(doc.id)).toBe('EXTRACTING');
      const approvedKinds = await t.rows<{ kind: string }>(
        `SELECT kind FROM "ShopDocument" WHERE "shopId" = :id AND status = 'APPROVED'`,
        { id: s.shopId },
      );
      expect(approvedKinds.map((k) => k.kind)).toEqual([
        'BUSINESS_REGISTRATION',
      ]);
      expect((await application(s.shopId)).status).toBe('SUBMITTED');
      expect(await events(s.shopId, 'shop.verified')).toEqual([]);

      await dropTrigger();
      await t.extraction.process(doc.id); // resumes with the stored attempt, no second model call
      expect(t.llm.requests).toHaveLength(2); // the registration and the statement, once each
      expect(await t.docStatus(doc.id)).toBe('APPROVED');
      expect((await application(s.shopId)).status).toBe('VERIFIED');
      expect(await events(s.shopId, 'shop.verified')).toHaveLength(1);
    });

    it('review path: the task stays open, no human attempt, the retry completes', async () => {
      const s = await t.submitted();
      await t.approved(s, 'BUSINESS_REGISTRATION');
      const statement = await reviewableStatement(s);
      await failVerifiedInserts();
      await resolve(statement.taskId).expect(500);
      const [task] = await t.rows<{ status: string }>(
        `SELECT status FROM "ReviewTask" WHERE id = :id`,
        { id: statement.taskId },
      );
      expect(task.status).toBe('OPEN');
      expect(await t.docStatus(statement.documentId)).toBe('NEEDS_REVIEW');
      expect(
        await t.rows(
          `SELECT 1 FROM "DocumentExtraction" WHERE "documentId" = :id AND model = 'human'`,
          { id: statement.documentId },
        ),
      ).toEqual([]);
      expect((await application(s.shopId)).status).toBe('SUBMITTED');

      await dropTrigger();
      const retry = await resolve(statement.taskId).expect(200);
      expect(retry.body).toEqual({ status: 'APPROVED', shopVerified: true });
      expect(await events(s.shopId, 'shop.verified')).toHaveLength(1);
    });
  });

  describe('S04 AS-54: event envelopes', () => {
    it('carries {eventId, type, version, occurredAt, aggregateId: shopId} and the contract payloads', async () => {
      const s = await t.submitted();
      const { taskId, documentId } = await reviewableStatement(s);
      await resolve(taskId, {
        decision: 'REJECT',
        reason: 'blurry scan',
      }).expect(200);
      const reg = await t.approved(s, 'BUSINESS_REGISTRATION');
      const bank = await t.approved(s, 'BANK_STATEMENT');
      expect(reg && bank).toBeTruthy();
      const rows = (await t.outbox(s.shopId)).filter(
        (r) => r.topic === 'shops.events',
      );
      expect(rows.map((r) => r.type)).toEqual([
        'shop.onboarding_submitted',
        'shop.onboarding_document_rejected',
        'shop.verified',
      ]);
      for (const row of rows) {
        const envelope = row.payload as Record<string, unknown>;
        expect(envelope).toMatchObject({
          type: row.type,
          version: 1,
          aggregateId: s.shopId,
        });
        expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
        expect(Number.isNaN(Date.parse(String(envelope.occurredAt)))).toBe(
          false,
        );
        expect(row.aggregateType).toBe('shops');
      }
      expect(rows[1].payload).toMatchObject({
        payload: { documentId, kind: 'BANK_STATEMENT', reason: 'blurry scan' },
      });
    });

    it('a refused operation appends nothing', async () => {
      const s = await t.submitted();
      const baseline = (await t.outbox(s.shopId)).length;
      const { taskId } = await reviewableStatement(s);
      const afterReview = (await t.outbox(s.shopId)).length; // llm.call_completed of the scripted call
      await t
        .http()
        .put(`/api/shops/${s.shopId}/onboarding/steps/nope`)
        .set(s.auth)
        .send({})
        .expect(400);
      await t
        .http()
        .post(`/api/shops/${s.shopId}/onboarding/documents`)
        .set(s.auth)
        .send({ kind: 'X' })
        .expect(400);
      await resolve(taskId, { decision: 'REJECT', reason: 'x' }).expect(400);
      await resolve(taskId, {
        decision: 'APPROVE',
        corrections: { nope: 'x' },
      }).expect(400);
      await resolve(v4(), { decision: 'APPROVE' }).expect(404);
      await t
        .http()
        .post(`/api/shops/${s.shopId}/onboarding/documents/${v4()}/uploaded`)
        .set(s.auth)
        .expect(404);
      expect((await t.outbox(s.shopId)).length).toBe(afterReview);
      expect(baseline).toBeLessThanOrEqual(afterReview);
    });
  });

  it('S04 AS-55: the seller sees statuses, reasons and progress - never extracted data, keys, models or attempts', async () => {
    const s = await t.submitted();
    const view = async () =>
      (
        await t
          .http()
          .get(`/api/shops/${s.shopId}/onboarding`)
          .set(s.auth)
          .expect(200)
      ).body;

    const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf('statement'));
    let body = expectContract(onboardingViewSchema, await view());
    expect(body.documents).toEqual([
      {
        id: doc.id,
        kind: 'BANK_STATEMENT',
        status: 'QUEUED',
        rejectionReason: null,
      },
    ]);
    expect(body.requiredDocuments).toEqual([
      { kind: 'BUSINESS_REGISTRATION', status: 'MISSING' },
      { kind: 'BANK_STATEMENT', status: 'QUEUED' },
    ]);

    t.llm.script(
      { text: bankAnswer('DE89 3704 ???? 0532', 'low') },
      { text: bankAnswer(BAD_IBAN_FOR_VIEW) },
    );
    await t.extraction.process(doc.id);
    body = expectContract(onboardingViewSchema, await view());
    expect(body.documents[0].status).toBe('NEEDS_REVIEW');
    const waiting = JSON.stringify(await view());
    for (const forbidden of [
      'iban',
      'DE89',
      '3001',
      '3704',
      'storageKey',
      'kyc/',
      'haiku',
      'opus',
      'model',
      'attempt',
      'iban_checksum',
      'sealed',
      'Müller',
    ])
      expect(waiting).not.toContain(forbidden);

    const [task] = await t.rows<{ id: string }>(
      `SELECT id FROM "ReviewTask" WHERE "documentId" = :id`,
      { id: doc.id },
    );
    await resolve(task.id, {
      decision: 'REJECT',
      reason: 'Statement is cropped',
    }).expect(200);
    body = expectContract(onboardingViewSchema, await view());
    expect(body.documents).toEqual([
      {
        id: doc.id,
        kind: 'BANK_STATEMENT',
        status: 'REJECTED',
        rejectionReason: 'Statement is cropped',
      },
    ]);
    expect(body.requiredDocuments![1]).toEqual({
      kind: 'BANK_STATEMENT',
      status: 'REJECTED',
    });

    await t.approved(s, 'BANK_STATEMENT');
    body = expectContract(onboardingViewSchema, await view());
    expect(body.requiredDocuments![1].status).toBe('APPROVED');
    expect(body.documents.map((d) => d.status)).toEqual(['APPROVED']); // the rejected file was superseded and is hidden
    const final = JSON.stringify(await view());
    for (const forbidden of [
      'DE89',
      '3000',
      'storageKey',
      'kyc/',
      'sealed',
      'Müller Handels GmbH',
    ])
      expect(final).not.toContain(forbidden);
  });
});

const BAD_IBAN_FOR_VIEW = 'DE89 3704 0044 0532 0130 01';
