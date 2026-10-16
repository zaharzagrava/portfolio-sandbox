import { createHash } from 'node:crypto';
import { v4 } from 'uuid';
import {
  documentConfirmResultSchema,
  documentUploadResultSchema,
  onboardingProblemSchema,
  onboardingViewSchema,
} from '@marketplace-sandbox/contracts';
import {
  ANSWERS,
  createOnboardingApp,
  expectContract,
  WITH_VAT,
  type OnboardingTestApp,
  type Seller,
} from './testing/onboarding-app';
import type { DocumentKind } from './domain/questionnaire';

describe('Seller onboarding: document intake (e2e)', () => {
  let t: OnboardingTestApp;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const request = (s: Seller, body: object) =>
    t
      .http()
      .post(`/api/shops/${s.shopId}/onboarding/documents`)
      .set(s.auth)
      .send(body);
  const requestFile = (
    s: Seller,
    kind: DocumentKind,
    bytes: Buffer,
    contentType = 'application/pdf',
  ) =>
    request(s, { kind, sha256: sha(bytes), size: bytes.length, contentType });
  const confirm = (s: Seller, id: string, shopId = s.shopId) =>
    t
      .http()
      .post(`/api/shops/${shopId}/onboarding/documents/${id}/uploaded`)
      .set(s.auth);
  const documentRows = (shopId: string) =>
    t.rows<{ id: string; kind: string; status: string; submissionNo: number }>(
      `SELECT id, kind, status, "submissionNo" FROM "ShopDocument" WHERE "shopId" = :shopId ORDER BY "createdAt", id`,
      { shopId },
    );
  const extractionTasks = (documentId?: string) =>
    t.rows<{ aggregateId: string; payload: unknown; kind: string }>(
      `SELECT "aggregateId", payload, kind FROM "Outbox" WHERE type = 'onboarding.extract_document'${
        documentId ? ` AND "aggregateId" = '${documentId}'` : ''
      }`,
    );
  const problem = (body: unknown) =>
    expectContract(onboardingProblemSchema, body);
  const setApplication = (shopId: string, status: string) =>
    t.db.query(
      `UPDATE "ShopOnboarding" SET status = '${status}' WHERE "shopId" = '${shopId}'`,
    );

  beforeAll(async () => {
    t = await createOnboardingApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.seeds.clean();
  });

  it('S04 AS-10: before the questionnaire is submitted a document request is a 409 and persists nothing', async () => {
    const s = await t.seller();
    await t.saveSteps(s);
    const res = await requestFile(s, 'BANK_STATEMENT', t.pdf('x')).expect(409);
    expect(problem(res.body).code).toBe('submission_required');
    expect(await documentRows(s.shopId)).toEqual([]);
  });

  it('S04 AS-11: a grant pinned to the declared hash and size, valid 15 minutes, without the storage key', async () => {
    const s = await t.submitted();
    const bytes = t.pdf('statement');
    const res = await requestFile(s, 'BANK_STATEMENT', bytes).expect(201);
    const body = expectContract(documentUploadResultSchema, res.body);
    expect(body).toMatchObject({
      document: {
        kind: 'BANK_STATEMENT',
        status: 'AWAITING_UPLOAD',
        rejectionReason: null,
      },
      deduplicated: false,
      upload: { method: 'PUT' },
    });
    expect(body.upload!.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(sha(bytes), 'hex').toString('base64'),
    );
    expect(body.upload!.headers['content-length']).toBe(String(bytes.length));
    const ttl =
      new Date(body.upload!.expiresAt).getTime() - t.clock.now().getTime();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(JSON.stringify(res.body.document)).not.toContain('kyc/');
    expect(res.body.document).not.toHaveProperty('storageKey');
    const [row] = await t.rows<{
      storageKey: string;
      contentHash: string;
      size: number;
      submissionNo: number;
    }>(
      `SELECT "storageKey", "contentHash", size, "submissionNo" FROM "ShopDocument" WHERE id = :id`,
      { id: body.document.id },
    );
    expect(row).toMatchObject({
      contentHash: sha(bytes),
      size: bytes.length,
      submissionNo: 1,
    });
    expect(row.storageKey).toContain(s.shopId);
    expect(await documentRows(s.shopId)).toHaveLength(1);
  });

  describe('S04 AS-12: request validation', () => {
    const ok = {
      kind: 'BANK_STATEMENT',
      sha256: 'a'.repeat(64),
      size: 100,
      contentType: 'application/pdf',
    };
    const cases: Array<[string, object, string]> = [
      ['kind outside the three', { ...ok, kind: 'PASSPORT' }, 'kind'],
      ['sha256 of 63 characters', { ...ok, sha256: 'a'.repeat(63) }, 'sha256'],
      ['sha256 in upper case', { ...ok, sha256: 'A'.repeat(64) }, 'sha256'],
      ['size 0', { ...ok, size: 0 }, 'size'],
      ['negative size', { ...ok, size: -5 }, 'size'],
      ['fractional size', { ...ok, size: 10.5 }, 'size'],
      ['PDF over 10 MB', { ...ok, size: 10 * 1024 * 1024 + 1 }, 'size'],
      [
        'PNG over 5 MB',
        { ...ok, contentType: 'image/png', size: 5 * 1024 * 1024 + 1 },
        'size',
      ],
      [
        'JPEG over 5 MB',
        { ...ok, contentType: 'image/jpeg', size: 5 * 1024 * 1024 + 1 },
        'size',
      ],
      [
        'WebP over 5 MB',
        { ...ok, contentType: 'image/webp', size: 5 * 1024 * 1024 + 1 },
        'size',
      ],
      [
        'content type outside the four',
        { ...ok, contentType: 'text/html' },
        'contentType',
      ],
      ['unknown field', { ...ok, storageKey: 'kyc/x' }, 'storageKey'],
      [
        'missing sha256',
        { kind: ok.kind, size: ok.size, contentType: ok.contentType },
        'sha256',
      ],
    ];
    it.each(cases)(
      '%s → 400 naming the field, no row',
      async (_label, body, path) => {
        const s = await t.submitted();
        const res = await request(s, body).expect(400);
        expect(problem(res.body).code).toBe('validation_failed');
        expect(problem(res.body).errors).toEqual(
          expect.arrayContaining([{ path, message: expect.any(String) }]),
        );
        expect(await documentRows(s.shopId)).toEqual([]);
      },
    );

    it('the maximum sizes themselves are accepted', async () => {
      const s = await t.submitted();
      await request(s, { ...ok, size: 10 * 1024 * 1024 }).expect(201);
      await request(s, {
        ...ok,
        sha256: 'b'.repeat(64),
        contentType: 'image/png',
        size: 5 * 1024 * 1024,
      }).expect(201);
    });
  });

  it('S04 AS-13: a VAT certificate is refused when the shop is not VAT registered', async () => {
    const s = await t.submitted();
    const res = await requestFile(s, 'VAT_CERTIFICATE', t.pdf('vat')).expect(
      422,
    );
    expect(problem(res.body).code).toBe('document_not_required');
    expect(await documentRows(s.shopId)).toEqual([]);
    const v = await t.submitted(WITH_VAT);
    await requestFile(v, 'VAT_CERTIFICATE', t.pdf('vat')).expect(201);
  });

  it('S04 AS-14: the same file is the same document (200, deduplicated); five racing requests make one row', async () => {
    const s = await t.submitted();
    const bytes = t.pdf('statement');
    const first = expectContract(
      documentUploadResultSchema,
      (await requestFile(s, 'BANK_STATEMENT', bytes).expect(201)).body,
    );
    const again = expectContract(
      documentUploadResultSchema,
      (await requestFile(s, 'BANK_STATEMENT', bytes).expect(200)).body,
    );
    expect(again).toMatchObject({
      deduplicated: true,
      document: { id: first.document.id },
    });
    expect(again.upload).not.toBeNull(); // still AWAITING_UPLOAD: a fresh grant

    const [{ storageKey }] = await t.rows<{ storageKey: string }>(
      `SELECT "storageKey" FROM "ShopDocument" WHERE id = :id`,
      { id: first.document.id },
    );
    await t.storage.put(storageKey, bytes, 'application/pdf');
    await confirm(s, first.document.id).expect(200);
    const afterConfirm = expectContract(
      documentUploadResultSchema,
      (await requestFile(s, 'BANK_STATEMENT', bytes).expect(200)).body,
    );
    expect(afterConfirm.upload).toBeNull();
    expect(afterConfirm.document.status).toBe('QUEUED');

    const racer = await t.submitted();
    const other = t.pdf('racing');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        requestFile(racer, 'BANK_STATEMENT', other),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      200, 200, 200, 200, 201,
    ]);
    expect(new Set(results.map((r) => r.body.document.id)).size).toBe(1);
    expect(await documentRows(racer.shopId)).toHaveLength(1);
  });

  describe('S04 AS-15 / AS-16: confirming an upload', () => {
    it('AS-15: QUEUED, one outbox command in the same transaction, a replay changes nothing', async () => {
      const s = await t.submitted();
      const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf('statement'));
      expect(await t.docStatus(doc.id)).toBe('QUEUED');
      const tasks = await extractionTasks(doc.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].kind).toBe('task');
      expect(JSON.stringify(tasks[0].payload)).toContain(doc.id);

      const replay = await confirm(s, doc.id).expect(200);
      expect(
        expectContract(documentConfirmResultSchema, replay.body),
      ).toMatchObject({ id: doc.id, status: 'QUEUED' });
      expect(await extractionTasks(doc.id)).toHaveLength(1);
      const history = await t.rows<{
        fromStatus: string | null;
        toStatus: string;
      }>(
        `SELECT "fromStatus", "toStatus" FROM "OnboardingStatusHistory" WHERE "entityId" = :id ORDER BY at, id`,
        { id: doc.id },
      );
      expect(history).toEqual([
        { fromStatus: null, toStatus: 'AWAITING_UPLOAD' },
        { fromStatus: 'AWAITING_UPLOAD', toStatus: 'QUEUED' },
      ]);
    });

    it('AS-15: racing confirmations queue the document once', async () => {
      const s = await t.submitted();
      const bytes = t.pdf('statement');
      const res = await requestFile(s, 'BANK_STATEMENT', bytes).expect(201);
      const id = res.body.document.id as string;
      const [{ storageKey }] = await t.rows<{ storageKey: string }>(
        `SELECT "storageKey" FROM "ShopDocument" WHERE id = :id`,
        { id },
      );
      await t.storage.put(storageKey, bytes, 'application/pdf');
      const results = await Promise.all(
        Array.from({ length: 5 }, () => confirm(s, id)),
      );
      for (const r of results) expect(r.status).toBe(200);
      expect(await extractionTasks(id)).toHaveLength(1);
    });

    it('AS-16: no object → 409 upload_not_received, nothing queued', async () => {
      const s = await t.submitted();
      const res = await requestFile(
        s,
        'BANK_STATEMENT',
        t.pdf('statement'),
      ).expect(201);
      const id = res.body.document.id as string;
      const failed = await confirm(s, id).expect(409);
      expect(problem(failed.body).code).toBe('upload_not_received');
      expect(await t.docStatus(id)).toBe('AWAITING_UPLOAD');
      expect(await extractionTasks(id)).toEqual([]);
    });

    it('AS-16: an object of another size → 422 upload_mismatch, the object is deleted', async () => {
      const s = await t.submitted();
      const bytes = t.pdf('statement');
      const res = await requestFile(s, 'BANK_STATEMENT', bytes).expect(201);
      const id = res.body.document.id as string;
      const [{ storageKey }] = await t.rows<{ storageKey: string }>(
        `SELECT "storageKey" FROM "ShopDocument" WHERE id = :id`,
        { id },
      );
      await t.storage.put(
        storageKey,
        Buffer.concat([bytes, Buffer.from('padding')]),
        'application/pdf',
      );
      const failed = await confirm(s, id).expect(422);
      expect(problem(failed.body).code).toBe('upload_mismatch');
      expect(await t.docStatus(id)).toBe('AWAITING_UPLOAD');
      expect(await t.storage.head(storageKey)).toBeNull();
      expect(await extractionTasks(id)).toEqual([]);
    });
  });

  it.each(['QUEUED', 'EXTRACTING', 'NEEDS_REVIEW', 'REJECTED'])(
    'S04 AS-17: a new file supersedes an older %s document of the kind and only the new one is queued',
    async (status) => {
      const s = await t.submitted();
      const old = await t.upload(s, 'BANK_STATEMENT', t.pdf('old'));
      await t.db.query(
        `UPDATE "ShopDocument" SET status = '${status}' WHERE id = '${old.id}'`,
      );
      if (status === 'NEEDS_REVIEW')
        await t.db.query(
          `INSERT INTO "ReviewTask" ("documentId", "shopId", reasons) VALUES ('${old.id}', '${s.shopId}', '[]')`,
        );
      const fresh = await t.upload(s, 'BANK_STATEMENT', t.pdf('new'));
      expect(await t.docStatus(old.id)).toBe('SUPERSEDED');
      expect(await t.docStatus(fresh.id)).toBe('QUEUED');
      const tasks = await t.rows<{ status: string }>(
        `SELECT status FROM "ReviewTask" WHERE "documentId" = :id`,
        { id: old.id },
      );
      expect(tasks.every((x) => x.status === 'CANCELLED')).toBe(true);
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
      expect(view.documents.map((d) => d.id)).toEqual([fresh.id]);
    },
  );

  describe('S04 AS-18: gates', () => {
    it('a kind with an approved document refuses another', async () => {
      const s = await t.submitted();
      const doc = await t.upload(s, 'BANK_STATEMENT', t.pdf('approved'));
      await t.db.query(
        `UPDATE "ShopDocument" SET status = 'APPROVED' WHERE id = '${doc.id}'`,
      );
      const res = await requestFile(
        s,
        'BANK_STATEMENT',
        t.pdf('another'),
      ).expect(409);
      expect(problem(res.body).code).toBe('document_already_approved');
      expect(await documentRows(s.shopId)).toHaveLength(1);
    });
    it('a verified application refuses every request', async () => {
      const s = await t.submitted();
      await setApplication(s.shopId, 'VERIFIED');
      const res = await requestFile(s, 'BANK_STATEMENT', t.pdf('x')).expect(
        409,
      );
      expect(problem(res.body).code).toBe('already_verified');
      expect(await documentRows(s.shopId)).toEqual([]);
    });
    it('a rejected application asks for a resubmission first', async () => {
      const s = await t.submitted();
      await setApplication(s.shopId, 'REJECTED');
      const res = await requestFile(s, 'BANK_STATEMENT', t.pdf('x')).expect(
        409,
      );
      expect(problem(res.body).code).toBe('resubmission_required');
      expect(await documentRows(s.shopId)).toEqual([]);
    });
  });

  it('S04 AS-19: a sixth distinct file of a kind is refused, superseded ones count, a de-duplicated request does not', async () => {
    const s = await t.submitted();
    const files = Array.from({ length: 5 }, (_, i) => t.pdf(`file ${i}`));
    for (const f of files)
      await requestFile(s, 'BANK_STATEMENT', f).expect(201);
    await t.db.query(
      `UPDATE "ShopDocument" SET status = 'SUPERSEDED' WHERE "shopId" = '${s.shopId}'`,
    );
    const res = await requestFile(s, 'BANK_STATEMENT', t.pdf('sixth')).expect(
      409,
    );
    expect(problem(res.body).code).toBe('onboarding_document_limit_reached');
    await requestFile(s, 'BANK_STATEMENT', files[0]).expect(200);
    await requestFile(s, 'BUSINESS_REGISTRATION', t.pdf('other kind')).expect(
      201,
    );
    expect(await documentRows(s.shopId)).toHaveLength(6);
  });

  describe('S04 AS-20: rate limits per shop', () => {
    it('21 upload requests in an hour: the 21st is 429 with Retry-After and persists nothing', async () => {
      const s = await t.submitted();
      const bytes = t.pdf('same');
      await requestFile(s, 'BANK_STATEMENT', bytes).expect(201);
      for (let i = 0; i < 19; i++)
        await requestFile(s, 'BANK_STATEMENT', bytes).expect(200);
      const limited = await requestFile(
        s,
        'BANK_STATEMENT',
        t.pdf('different'),
      ).expect(429);
      expect(problem(limited.body).code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(await documentRows(s.shopId)).toHaveLength(1);
      // another shop is not affected
      const other = await t.submitted();
      await requestFile(other, 'BANK_STATEMENT', bytes).expect(201);
    });

    it('11 submits in a day: the 11th is 429 and persists nothing', async () => {
      const s = await t.seller();
      for (let i = 0; i < 10; i++)
        await t
          .http()
          .post(`/api/shops/${s.shopId}/onboarding/submit`)
          .set(s.auth)
          .expect(400);
      const limited = await t
        .http()
        .post(`/api/shops/${s.shopId}/onboarding/submit`)
        .set(s.auth)
        .expect(429);
      expect(problem(limited.body).code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(
        await t.rows(`SELECT 1 FROM "ShopOnboarding" WHERE "shopId" = :id`, {
          id: s.shopId,
        }),
      ).toEqual([]);
    });
  });

  it("S04 AS-21: another shop's document is a 404 identical to an unknown one; its documents never show in the view", async () => {
    const a = await t.submitted();
    const b = await t.submitted();
    const doc = await t.upload(a, 'BANK_STATEMENT', t.pdf('a-statement'));
    const crossTenant = await confirm(b, doc.id).expect(404);
    const unknown = await confirm(b, v4()).expect(404);
    const malformed = await confirm(b, 'not-a-uuid').expect(404);
    for (const r of [crossTenant, unknown, malformed])
      expect(problem(r.body).code).toBe('document_not_found');
    expect(crossTenant.body.detail).toBe(unknown.body.detail);
    const view = expectContract(
      onboardingViewSchema,
      (
        await t
          .http()
          .get(`/api/shops/${b.shopId}/onboarding`)
          .set(b.auth)
          .expect(200)
      ).body,
    );
    expect(view.documents).toEqual([]);
    expect(await t.docStatus(doc.id)).toBe('QUEUED');
    expect(ANSWERS.business.country).toBe('DE');
  });
});
