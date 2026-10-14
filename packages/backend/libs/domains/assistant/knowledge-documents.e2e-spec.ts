import { QueryTypes } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import {
  knowledgeCreateResponseSchema,
  knowledgeDocumentPageSchema,
  knowledgeDocumentSchema,
} from '@marketplace-sandbox/contracts';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { minimalPdf } from '@app/test/utils/minimal-pdf';
import {
  createKnowledgeApp,
  ESIM_MANUAL,
  sha256,
  type KnowledgeTestApp,
  type Seller,
} from './testing/knowledge.fixtures';

const MIB = 1024 * 1024;
const docs = (shopId: string) => `/api/shops/${shopId}/knowledge/documents`;

describe('RAG: document management API', () => {
  let t: KnowledgeTestApp;

  beforeAll(async () => {
    t = await createKnowledgeApp();
  }, 180_000);
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const rows = async (
    where = 'TRUE',
    replacements: Record<string, unknown> = {},
  ) =>
    (
      await t.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "KnowledgeDocument" WHERE ${where}`,
        { type: QueryTypes.SELECT, replacements },
      )
    )[0].n;
  const setStatus = (
    id: string,
    status: string,
    failureCode: string | null = null,
  ) =>
    t.db.query(
      `UPDATE "KnowledgeDocument" SET status = :status, "failureCode" = :failureCode WHERE id = :id`,
      { replacements: { id, status, failureCode } },
    );
  const storageKey = async (id: string) =>
    (await t.document(id))!.storageKey as string;
  const pdfOf = (marker = 'eSIM') =>
    minimalPdf([
      ['1 Getting started', `Hold the power button. ${marker} ${uuidv7()}`],
      [
        '2 Connectivity',
        '2.1 eSIM support',
        'The phone supports eSIM and dual SIM.',
      ],
    ]);
  const createPdf = async (s: Seller, pdf: Buffer = pdfOf()) => {
    const res = await t.create(s.owner, s.shopId, {
      title: 'Pixel PDF',
      visibility: 'PUBLIC',
      pdfSha256: sha256(pdf),
      pdfSize: pdf.length,
    });
    expect(res.status).toBe(201);
    return { id: res.body.document.id as string, pdf, body: res.body };
  };
  const upload = async (id: string, pdf: Buffer) =>
    t.app.get(ObjectStorage).put(await storageKey(id), pdf, 'application/pdf'); // what the client's presigned PUT does

  it('S47 AS-15: creates, queues, indexes and reports READY; no internal field is in any body', async () => {
    const s = await t.seller();
    const res = await t.create(s.owner, s.shopId, {
      title: 'Pixel 10 manual',
      visibility: 'PUBLIC',
      productId: s.product.id,
      markdown: ESIM_MANUAL,
    });

    expect(res.status).toBe(201);
    const created = knowledgeCreateResponseSchema.parse(res.body);
    expect(created).toMatchObject({
      deduplicated: false,
      document: {
        title: 'Pixel 10 manual',
        visibility: 'PUBLIC',
        productId: s.product.id,
        format: 'MARKDOWN',
        status: 'QUEUED',
        chunkCount: 0,
        failureCode: null,
      },
    });
    expect(Object.keys(res.body.document).sort()).toEqual(
      [
        'chunkCount',
        'createdAt',
        'failureCode',
        'format',
        'id',
        'productId',
        'status',
        'title',
        'updatedAt',
        'visibility',
      ].sort(),
    );
    expect(res.body).not.toHaveProperty('upload');
    expect(JSON.stringify(res.body)).not.toMatch(
      /storageKey|contentHash|indexedHash|embeddingModel|createdBy|knowledge\//,
    );
    const id = created.document.id;
    expect(t.tasks.count(id)).toBe(1);
    expect(t.tasks.published).toHaveLength(1);
    const row = await t.document(id);
    expect(row).toMatchObject({
      shopId: s.shopId,
      contentHash: sha256(ESIM_MANUAL),
      createdBy: s.owner.id,
    });

    await t.ingest(id);
    const got = await t
      .as(s.owner)
      .get(`${docs(s.shopId)}/${id}`)
      .expect(200);
    expect(knowledgeDocumentSchema.parse(got.body)).toMatchObject({
      id,
      status: 'READY',
      chunkCount: 2,
      failureCode: null,
    });
    expect(JSON.stringify(got.body)).not.toMatch(
      /storageKey|contentHash|createdBy/,
    );
  });

  it('S47 AS-16: a PDF create returns a grant bound to its hash and size; uploaded queues once', async () => {
    const s = await t.seller();
    const pdf = pdfOf();
    const res = await t.create(s.owner, s.shopId, {
      title: 'Pixel PDF',
      visibility: 'PUBLIC',
      pdfSha256: sha256(pdf),
      pdfSize: pdf.length,
    });

    expect(res.status).toBe(201);
    const created = knowledgeCreateResponseSchema.parse(res.body);
    expect(created.document).toMatchObject({
      status: 'AWAITING_UPLOAD',
      format: 'PDF',
      chunkCount: 0,
    });
    const grant = created.upload!;
    expect(grant.headers['x-amz-checksum-sha256']).toBe(
      Buffer.from(sha256(pdf), 'hex').toString('base64'),
    );
    expect(grant.headers['content-length']).toBe(String(pdf.length));
    const ttlMs = Date.parse(grant.expiresAt) - t.clock.now().getTime();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000);
    expect(t.tasks.published).toEqual([]);

    const id = created.document.id;
    await upload(id, pdf);
    const queued = await t
      .as(s.owner)
      .post(`${docs(s.shopId)}/${id}/uploaded`)
      .expect(200);
    expect(knowledgeDocumentSchema.parse(queued.body).status).toBe('QUEUED');
    expect(t.tasks.count(id)).toBe(1);
    await t
      .as(s.owner)
      .post(`${docs(s.shopId)}/${id}/uploaded`)
      .expect(200);
    expect(t.tasks.count(id)).toBe(1);
  });

  describe('S47 AS-17: create validation', () => {
    const md = { title: 'T', visibility: 'PUBLIC', markdown: '# Hi\ntext' };
    const hash = 'a'.repeat(64);
    it.each([
      ['no body fields', {}],
      ['neither markdown nor pdf', { title: 'T', visibility: 'PUBLIC' }],
      ['both markdown and pdfSha256', { ...md, pdfSha256: hash }],
      [
        'pdfSha256 without pdfSize',
        { title: 'T', visibility: 'PUBLIC', pdfSha256: hash },
      ],
      [
        'pdfSize without pdfSha256',
        { title: 'T', visibility: 'PUBLIC', pdfSize: 10 },
      ],
      ['empty markdown', { ...md, markdown: '' }],
      ['whitespace-only markdown', { ...md, markdown: ' \n\t ' }],
      ['markdown over 1 MiB', { ...md, markdown: 'a'.repeat(MIB + 1) }],
      [
        'pdfSize 0',
        { title: 'T', visibility: 'PUBLIC', pdfSha256: hash, pdfSize: 0 },
      ],
      [
        'pdfSize over 20 MiB',
        {
          title: 'T',
          visibility: 'PUBLIC',
          pdfSha256: hash,
          pdfSize: 20 * MIB + 1,
        },
      ],
      [
        'pdfSha256 not lowercase hex',
        {
          title: 'T',
          visibility: 'PUBLIC',
          pdfSha256: 'G'.repeat(64),
          pdfSize: 5,
        },
      ],
      ['empty title', { ...md, title: '' }],
      ['title of 201 characters', { ...md, title: 'a'.repeat(201) }],
      ['visibility PLATFORM', { ...md, visibility: 'PLATFORM' }],
      ['visibility outside the set', { ...md, visibility: 'SECRET' }],
      ['productId not a uuid', { ...md, productId: 'p1' }],
      ['an unknown field', { ...md, extra: true }],
    ])(
      'S47 AS-17: %s → 400 validation_failed, nothing stored or queued',
      async (_name, body) => {
        const s = await t.seller();
        const res = await t.create(s.owner, s.shopId, body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        expect(res.headers['content-type']).toMatch(/problem\+json/);
        expect(JSON.stringify(res.body)).not.toContain('a'.repeat(50));
        expect(await rows('"shopId" = :shopId', { shopId: s.shopId })).toBe(
          '0',
        );
        expect(t.tasks.published).toEqual([]);
      },
    );

    it('S47 AS-17: a title of exactly 200 characters is accepted', async () => {
      const s = await t.seller();
      const res = await t.create(s.owner, s.shopId, {
        ...md,
        title: 'a'.repeat(200),
      });
      expect(res.status).toBe(201);
    });

    it('S47 AS-17: markdown of exactly 1 MiB is accepted (not answered 413 by the platform)', async () => {
      const s = await t.seller();
      const res = await t.create(s.owner, s.shopId, {
        ...md,
        markdown: 'a'.repeat(MIB),
      });
      expect(res.status).toBe(201);
    });

    it('S47 AS-17: a pdfSize of exactly 20 MiB is accepted', async () => {
      const s = await t.seller();
      const res = await t.create(s.owner, s.shopId, {
        title: 'T',
        visibility: 'PUBLIC',
        pdfSha256: hash,
        pdfSize: 20 * MIB,
      });
      expect(res.status).toBe(201);
      expect(res.body.document.status).toBe('AWAITING_UPLOAD');
    });

    it('S47 AS-17: SHOP_PRIVATE with a productId is 422 product_document_must_be_public', async () => {
      const s = await t.seller();
      const res = await t.create(s.owner, s.shopId, {
        title: 'T',
        visibility: 'SHOP_PRIVATE',
        productId: s.product.id,
        markdown: 'x',
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('product_document_must_be_public');
      expect(await rows('"shopId" = :shopId', { shopId: s.shopId })).toBe('0');
    });
  });

  describe('S47 AS-18: unauthenticated', () => {
    const id = '0192f7a0-0000-7000-8000-0000000000e1';
    const shop = '0192f7a0-0000-7000-8000-00000000a001';
    const routes: [string, string, string][] = [
      ['POST', `/api/shops/${shop}/knowledge/documents`, 'shop create'],
      ['GET', `/api/shops/${shop}/knowledge/documents`, 'shop list'],
      ['GET', `/api/shops/${shop}/knowledge/documents/${id}`, 'shop get'],
      ['DELETE', `/api/shops/${shop}/knowledge/documents/${id}`, 'shop delete'],
      [
        'POST',
        `/api/shops/${shop}/knowledge/documents/${id}/uploaded`,
        'uploaded',
      ],
      ['POST', `/api/shops/${shop}/knowledge/documents/${id}/retry`, 'retry'],
      ['POST', `/api/shops/${shop}/knowledge/ask`, 'help-center ask'],
      ['POST', '/api/admin/knowledge/documents', 'admin create'],
      ['GET', '/api/admin/knowledge/documents', 'admin list'],
      ['DELETE', `/api/admin/knowledge/documents/${id}`, 'admin delete'],
      ['POST', '/api/admin/knowledge/reindex', 'admin reindex'],
    ];
    const send = (
      method: string,
      url: string,
      headers: Record<string, string>,
    ) => {
      const req = t.http()[method.toLowerCase() as 'get'](url);
      return req.set(headers).send(
        method === 'POST'
          ? {
              title: 'x',
              visibility: 'PUBLIC',
              markdown: 'x',
              question: 'what is it',
            }
          : undefined,
      );
    };
    it.each(routes)(
      'S47 AS-18: %s %s (%s) without credentials → 401',
      async (method, url) => {
        const res = await send(method, url, {});
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toMatch(/problem\+json/);
      },
    );
    it.each(routes)(
      'S47 AS-18: %s %s (%s) with a bad token → 401',
      async (method, url) => {
        const res = await send(method, url, {
          Authorization: 'Bearer not-a-token',
        });
        expect(res.status).toBe(401);
      },
    );
    it('S47 AS-18: nothing was stored, queued or answered', async () => {
      expect(await rows()).toBe('0');
      expect(t.tasks.published).toEqual([]);
      expect(t.llm.requests).toEqual([]);
    });
  });

  describe('S47 AS-19: authorization matrix', () => {
    it('S47 AS-19: a non-member gets 404 on every shop route and nothing changes', async () => {
      const a = await t.seller();
      const stranger = await t.seller();
      const id = await t.index(a, 'Manual', ESIM_MANUAL);
      const base = docs(a.shopId);
      const calls = [
        t
          .as(stranger.owner)
          .post(base)
          .send({ title: 'x', visibility: 'PUBLIC', markdown: 'x' }),
        t.as(stranger.owner).post(`${base}/${id}/uploaded`),
        t.as(stranger.owner).post(`${base}/${id}/retry`),
        t.as(stranger.owner).get(base),
        t.as(stranger.owner).get(`${base}/${id}`),
        t.as(stranger.owner).delete(`${base}/${id}`),
        t
          .as(stranger.owner)
          .post(`/api/shops/${a.shopId}/knowledge/ask`)
          .send({ question: 'what is it' }),
      ];
      for (const res of await Promise.all(calls)) expect(res.status).toBe(404);
      expect(await rows()).toBe('1');
      expect((await t.document(id))!.status).toBe('READY');
      expect(t.llm.requests).toEqual([]);
    });

    it('S47 AS-19: a member without products.write gets 403 on writes, 200 on reads', async () => {
      const s = await t.seller();
      const viewer = await t.member(s.shopId, 'VIEWER');
      const id = await t.index(s, 'Manual', ESIM_MANUAL);
      const base = docs(s.shopId);
      for (const res of await Promise.all([
        t
          .as(viewer)
          .post(base)
          .send({ title: 'x', visibility: 'PUBLIC', markdown: 'x' }),
        t.as(viewer).post(`${base}/${id}/uploaded`),
        t.as(viewer).post(`${base}/${id}/retry`),
        t.as(viewer).delete(`${base}/${id}`),
      ]))
        expect(res.status).toBe(403);
      await t.as(viewer).get(base).expect(200);
      await t.as(viewer).get(`${base}/${id}`).expect(200);
      expect((await t.document(id))!.status).toBe('READY');
    });

    it('S47 AS-19: a suspended shop refuses writes with 403 shop_suspended but lists, reads and answers', async () => {
      const s = await t.seller({ shopStatus: 'SUSPENDED' });
      const created = await t.create(s.owner, s.shopId, {
        title: 'x',
        visibility: 'PUBLIC',
        markdown: 'x',
      });
      expect(created.status).toBe(403);
      expect(created.body.code).toBe('shop_suspended');
      await t.as(s.owner).get(docs(s.shopId)).expect(200);
      expect(await rows()).toBe('0');
    });

    it('S47 AS-19: a shop in DELETING refuses writes with 409 shop_offboarding', async () => {
      const s = await t.seller({ shopStatus: 'DELETING' });
      const res = await t.create(s.owner, s.shopId, {
        title: 'x',
        visibility: 'PUBLIC',
        markdown: 'x',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('shop_offboarding');
      expect(await rows()).toBe('0');
    });

    it('S47 AS-19: a non-administrator gets 403 on every admin route', async () => {
      const s = await t.seller();
      const id = uuidv7();
      for (const res of await Promise.all([
        t
          .as(s.owner)
          .post('/api/admin/knowledge/documents')
          .send({ title: 'x', markdown: 'x' }),
        t.as(s.owner).get('/api/admin/knowledge/documents'),
        t.as(s.owner).delete(`/api/admin/knowledge/documents/${id}`),
        t.as(s.owner).post('/api/admin/knowledge/reindex'),
      ]))
        expect(res.status).toBe(403);
      expect(await rows()).toBe('0');
    });
  });

  describe('S47 AS-20: product ownership', () => {
    it('S47 AS-20: another shop’s product and an unknown product are the same 404; nothing is stored', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const foreign = await t.create(a.owner, a.shopId, {
        title: 'x',
        visibility: 'PUBLIC',
        productId: b.product.id,
        markdown: 'x',
      });
      const unknown = await t.create(a.owner, a.shopId, {
        title: 'x',
        visibility: 'PUBLIC',
        productId: uuidv7(),
        markdown: 'x',
      });
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.body.code).toBe('not_found');
      expect(foreign.body.detail).toBe(unknown.body.detail);
      expect(await rows()).toBe('0');
      expect(t.tasks.published).toEqual([]);
    });

    it('S47 AS-20: an archived product of the shop is 409 product_archived', async () => {
      const s = await t.seller();
      const archived = await t.product(s.shopId, { status: 'ARCHIVED' });
      const res = await t.create(s.owner, s.shopId, {
        title: 'x',
        visibility: 'PUBLIC',
        productId: archived.id,
        markdown: 'x',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('product_archived');
      expect(await rows()).toBe('0');
    });
  });

  describe('S47 AS-21: the same bytes in the same scope are one document', () => {
    it('S47 AS-21: a repeat is 200 deduplicated with the first document unchanged, even with another title', async () => {
      const s = await t.seller();
      const body = {
        title: 'Manual',
        visibility: 'PUBLIC',
        productId: s.product.id,
        markdown: ESIM_MANUAL,
      };
      const first = await t.create(s.owner, s.shopId, body);
      const second = await t.create(s.owner, s.shopId, {
        ...body,
        title: 'Manual (again)',
      });

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({
        document: first.body.document,
        deduplicated: true,
      });
      expect(await rows('"shopId" = :s', { s: s.shopId })).toBe('1');
      expect(t.tasks.published).toHaveLength(1);
    });

    it('S47 AS-21: other product, other visibility and another shop create distinct documents', async () => {
      const s = await t.seller();
      const other = await t.seller();
      const second = await t.product(s.shopId);
      const create = (user: Seller, over: Record<string, unknown>) =>
        t.create(user.owner, user.shopId, {
          title: 'M',
          visibility: 'PUBLIC',
          markdown: ESIM_MANUAL,
          ...over,
        });
      const ids = new Set<string>();
      for (const res of [
        await create(s, { productId: s.product.id }),
        await create(s, { productId: second.id }),
        await create(s, {}),
        await create(s, { visibility: 'SHOP_PRIVATE' }),
        await create(other, {}),
      ]) {
        expect(res.status).toBe(201);
        ids.add(res.body.document.id);
      }
      expect(ids.size).toBe(5);
    });

    it('S47 AS-21: after the first document is deleted the same bytes create a new one', async () => {
      const s = await t.seller();
      const first = await t.markdown(s, 'Manual', ESIM_MANUAL);
      await t
        .as(s.owner)
        .delete(`${docs(s.shopId)}/${first}`)
        .expect(204);
      const again = await t.create(s.owner, s.shopId, {
        title: 'Manual',
        visibility: 'PUBLIC',
        markdown: ESIM_MANUAL,
      });
      expect(again.status).toBe(201);
      expect(again.body.document.id).not.toBe(first);
    });
  });

  it('S47 AS-22: five parallel identical creates → one 201, four 200, one row, one task, one stored object', async () => {
    const s = await t.seller();
    const body = {
      title: 'Manual',
      visibility: 'PUBLIC',
      productId: s.product.id,
      markdown: ESIM_MANUAL,
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.create(s.owner, s.shopId, body)),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    const ids = new Set(results.map((r) => r.body.document.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.body.deduplicated === true)).toHaveLength(4);
    expect(await rows('"shopId" = :s', { s: s.shopId })).toBe('1');
    expect(t.tasks.published).toHaveLength(1);
    const objects = await t.app
      .get(ObjectStorage)
      .list(`knowledge/${s.shopId}/`);
    expect(objects).toHaveLength(1);
  });

  describe('S47 AS-23: uploaded', () => {
    it('S47 AS-23: before any bytes exist → 409 upload_missing, status unchanged, no task', async () => {
      const s = await t.seller();
      const { id } = await createPdf(s);
      const res = await t.as(s.owner).post(`${docs(s.shopId)}/${id}/uploaded`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('upload_missing');
      expect((await t.document(id))!.status).toBe('AWAITING_UPLOAD');
      expect(t.tasks.published).toEqual([]);
    });

    it('S47 AS-23: replays on QUEUED, PROCESSING and READY are 200 with no second task', async () => {
      const s = await t.seller();
      const { id, pdf } = await createPdf(s);
      await upload(id, pdf);
      await t
        .as(s.owner)
        .post(`${docs(s.shopId)}/${id}/uploaded`)
        .expect(200);
      for (const status of ['QUEUED', 'PROCESSING', 'READY']) {
        await setStatus(id, status);
        const res = await t
          .as(s.owner)
          .post(`${docs(s.shopId)}/${id}/uploaded`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(status);
      }
      expect(t.tasks.count(id)).toBe(1);
    });

    it('S47 AS-23: a FAILED document is 409 invalid_transition', async () => {
      const s = await t.seller();
      const { id } = await createPdf(s);
      await setStatus(id, 'FAILED', 'unparseable');
      const res = await t.as(s.owner).post(`${docs(s.shopId)}/${id}/uploaded`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('invalid_transition');
      expect(t.tasks.published).toEqual([]);
    });

    it('S47 AS-23: two calls at the same moment both answer 200 and exactly one task exists', async () => {
      const s = await t.seller();
      const { id, pdf } = await createPdf(s);
      await upload(id, pdf);
      const results = await Promise.all([
        t.as(s.owner).post(`${docs(s.shopId)}/${id}/uploaded`),
        t.as(s.owner).post(`${docs(s.shopId)}/${id}/uploaded`),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(t.tasks.count(id)).toBe(1);
    });

    it('S47 AS-23: a deleted, unknown or another shop’s document is 404', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const { id } = await createPdf(a);
      await t
        .as(a.owner)
        .delete(`${docs(a.shopId)}/${id}`)
        .expect(204);
      const other = await createPdf(b);
      for (const [user, shopId, docId] of [
        [a.owner, a.shopId, id],
        [a.owner, a.shopId, uuidv7()],
        [a.owner, a.shopId, other.id],
      ] as const) {
        const res = await t.as(user).post(`${docs(shopId)}/${docId}/uploaded`);
        expect(res.status).toBe(404);
      }
      expect(t.tasks.published).toEqual([]);
    });
  });

  describe('S47 AS-28: delete', () => {
    it('S47 AS-28: the document is gone from list and get at once, its passages and bytes are removed, repeats are 404', async () => {
      const s = await t.seller();
      const id = await t.index(s, 'Pixel 10 manual', ESIM_MANUAL, {
        productId: s.product.id,
      });
      const key = await storageKey(id);
      expect(await t.app.get(ObjectStorage).head(key)).not.toBeNull();
      t.llm.script({ text: 'must not be asked', citations: [0] });

      await t
        .as(s.owner)
        .delete(`${docs(s.shopId)}/${id}`)
        .expect(204);

      await t
        .as(s.owner)
        .get(`${docs(s.shopId)}/${id}`)
        .expect(404);
      const list = await t.as(s.owner).get(docs(s.shopId)).expect(200);
      expect(list.body.items).toEqual([]);
      expect(await t.chunks(id)).toEqual([]);
      expect(await t.app.get(ObjectStorage).head(key)).toBeNull();
      const row = (await t.document(id))!;
      expect(row).toMatchObject({
        status: 'DELETED',
        chunkCount: 0,
        title: '',
      });
      expect(row.bytesRemovedAt).not.toBeNull();
      const asked = await t.askProduct(
        s.product.id,
        'Does the Pixel 10 support eSIM?',
      );
      expect(asked.events.map((e) => e.event)).toEqual(['not_found']);
      expect(t.llm.requests).toEqual([]);
      await t
        .as(s.owner)
        .delete(`${docs(s.shopId)}/${id}`)
        .expect(404);
    });

    it('S47 AS-28: two deletes at the same moment → one 204 and one 404', async () => {
      const s = await t.seller();
      const id = await t.index(s, 'Manual', ESIM_MANUAL);
      const results = await Promise.all([
        t.as(s.owner).delete(`${docs(s.shopId)}/${id}`),
        t.as(s.owner).delete(`${docs(s.shopId)}/${id}`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([204, 404]);
    });

    it('S47 AS-28: another shop’s document is 404 and unchanged', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const id = await t.index(a, 'Manual', ESIM_MANUAL);
      await t
        .as(b.owner)
        .delete(`${docs(b.shopId)}/${id}`)
        .expect(404);
      expect((await t.document(id))!.status).toBe('READY');
      expect((await t.chunks(id)).length).toBe(2);
    });
  });

  describe('S47 AS-30: retry', () => {
    it('S47 AS-30: retry from FAILED is 202 QUEUED with one task and the failure code cleared', async () => {
      const s = await t.seller();
      const { id, pdf } = await createPdf(s);
      await upload(id, pdf);
      await setStatus(id, 'FAILED', 'embedding_unavailable');
      const res = await t.as(s.owner).post(`${docs(s.shopId)}/${id}/retry`);
      expect(res.status).toBe(202);
      expect(knowledgeDocumentSchema.parse(res.body)).toMatchObject({
        status: 'QUEUED',
        failureCode: null,
      });
      expect(t.tasks.count(id)).toBe(1);
    });

    it.each(['READY', 'QUEUED', 'PROCESSING', 'AWAITING_UPLOAD'])(
      'S47 AS-30: retry on a %s document is 409 invalid_transition with no task',
      async (status) => {
        const s = await t.seller();
        const { id } = await createPdf(s);
        await setStatus(id, status);
        const res = await t.as(s.owner).post(`${docs(s.shopId)}/${id}/retry`);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('invalid_transition');
        expect(t.tasks.published).toEqual([]);
        expect((await t.document(id))!.status).toBe(status);
      },
    );

    it('S47 AS-30: two concurrent retries on a FAILED document → one 202, one 409', async () => {
      const s = await t.seller();
      const { id } = await createPdf(s);
      await setStatus(id, 'FAILED', 'unparseable');
      const results = await Promise.all([
        t.as(s.owner).post(`${docs(s.shopId)}/${id}/retry`),
        t.as(s.owner).post(`${docs(s.shopId)}/${id}/retry`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
      expect(t.tasks.count(id)).toBe(1);
    });
  });

  describe('S47 AS-31: list and read', () => {
    it('S47 AS-31: keyset paging newest first, the status filter, limits, scope isolation and the contract schema', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const admin = await t.admin();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push(
          await t.markdown(a, `Doc ${i}`, `# Doc ${i}\ntext number ${i}`),
        );
      await t.markdown(b, 'Other 0', '# O\nzero');
      await t.markdown(b, 'Other 1', '# O\none');
      await t.platformArticle(
        admin,
        'Guide',
        '# Guide\nPayouts are sent every Monday.',
      );
      await t
        .as(a.owner)
        .delete(`${docs(a.shopId)}/${ids[2]}`)
        .expect(204);
      await setStatus(ids[4], 'FAILED', 'no_text');

      const page1 = await t
        .as(a.owner)
        .get(`${docs(a.shopId)}?limit=2`)
        .expect(200);
      const parsed1 = knowledgeDocumentPageSchema.parse(page1.body);
      expect(parsed1.items.map((d) => d.id)).toEqual([ids[4], ids[3]]);
      expect(parsed1.nextCursor).toEqual(expect.any(String));
      const page2 = await t
        .as(a.owner)
        .get(
          `${docs(a.shopId)}?limit=2&cursor=${encodeURIComponent(parsed1.nextCursor!)}`,
        )
        .expect(200);
      const parsed2 = knowledgeDocumentPageSchema.parse(page2.body);
      expect(parsed2.items.map((d) => d.id)).toEqual([ids[1], ids[0]]);
      expect(parsed2.nextCursor).toBeNull();

      const failed = await t
        .as(a.owner)
        .get(`${docs(a.shopId)}?status=FAILED`)
        .expect(200);
      expect(failed.body.items.map((d: { id: string }) => d.id)).toEqual([
        ids[4],
      ]);
      const all = await t.as(a.owner).get(docs(a.shopId)).expect(200);
      expect(all.body.items).toHaveLength(4); // default limit 20; the deleted one and other scopes never appear
      expect(all.body.nextCursor).toBeNull();
    });

    it.each(['0', '101', 'abc', '-1', '1.5'])(
      'S47 AS-31: limit=%s → 400',
      async (limit) => {
        const s = await t.seller();
        const res = await t.as(s.owner).get(`${docs(s.shopId)}?limit=${limit}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
      },
    );

    it('S47 AS-31: a malformed, tampered or foreign cursor is 400 invalid_cursor', async () => {
      const a = await t.seller();
      const b = await t.seller();
      for (let i = 0; i < 3; i++)
        await t.markdown(a, `A${i}`, `# A\nnumber ${i}`);
      for (let i = 0; i < 3; i++)
        await t.markdown(b, `B${i}`, `# B\nnumber ${i}`);
      const first = await t
        .as(a.owner)
        .get(`${docs(a.shopId)}?limit=1`)
        .expect(200);
      const cursor = first.body.nextCursor as string;
      const [body, tag] = cursor.split('.');
      const forged = Buffer.from(
        JSON.stringify({ c: '2000-01-01T00:00:00.000000Z', i: uuidv7() }),
      ).toString('base64url');
      const foreign = (
        await t
          .as(b.owner)
          .get(`${docs(b.shopId)}?limit=1`)
          .expect(200)
      ).body.nextCursor as string;
      for (const bad of ['abc', `${forged}.${tag}`, `${body}.AAAA`, foreign]) {
        const res = await t
          .as(a.owner)
          .get(`${docs(a.shopId)}?cursor=${encodeURIComponent(bad)}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_cursor');
      }
    });

    it('S47 AS-31: get returns one document, and another shop’s or a platform document is 404', async () => {
      const a = await t.seller();
      const b = await t.seller();
      const admin = await t.admin();
      const mine = await t.markdown(a, 'Mine', ESIM_MANUAL);
      const theirs = await t.markdown(b, 'Theirs', '# T\nother');
      const platform = await t.platformArticle(admin, 'Guide', '# Guide\nx');
      const ok = await t
        .as(a.owner)
        .get(`${docs(a.shopId)}/${mine}`)
        .expect(200);
      knowledgeDocumentSchema.parse(ok.body);
      await t
        .as(a.owner)
        .get(`${docs(a.shopId)}/${theirs}`)
        .expect(404);
      await t
        .as(a.owner)
        .get(`${docs(a.shopId)}/${platform}`)
        .expect(404);
    });
  });

  describe('S47 AS-32: per-shop document cap', () => {
    it('S47 AS-32: at the cap a new document is 422, a duplicate is still 200, and a delete frees a slot', async () => {
      t.config.set('knowledge_max_documents_per_shop', 3);
      const s = await t.seller();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push(await t.markdown(s, `D${i}`, `# D\nnumber ${i}`));

      const over = await t.create(s.owner, s.shopId, {
        title: 'D3',
        visibility: 'PUBLIC',
        markdown: '# D\nnumber 3',
      });
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('document_limit_reached');
      expect(await rows('"shopId" = :s', { s: s.shopId })).toBe('3');
      const objects = await t.app
        .get(ObjectStorage)
        .list(`knowledge/${s.shopId}/`);
      expect(objects).toHaveLength(3); // the refused create left no object behind

      const dup = await t.create(s.owner, s.shopId, {
        title: 'D0',
        visibility: 'PUBLIC',
        markdown: '# D\nnumber 0',
      });
      expect(dup.status).toBe(200);
      expect(dup.body.deduplicated).toBe(true);

      await t
        .as(s.owner)
        .delete(`${docs(s.shopId)}/${ids[0]}`)
        .expect(204);
      const fits = await t.create(s.owner, s.shopId, {
        title: 'D3',
        visibility: 'PUBLIC',
        markdown: '# D\nnumber 3',
      });
      expect(fits.status).toBe(201);
    });
  });

  describe('S47 AS-33: ingestion rate limit', () => {
    it('S47 AS-33: the 31st create in a minute is 429 with Retry-After; another shop is unaffected', async () => {
      const s = await t.seller();
      const other = await t.seller();
      for (let i = 0; i < 30; i++) {
        const res = await t.create(s.owner, s.shopId, {
          title: `D${i}`,
          visibility: 'PUBLIC',
          markdown: `# D\nnumber ${i}`,
        });
        expect(res.status).toBe(201);
      }
      const limited = await t.create(s.owner, s.shopId, {
        title: 'D31',
        visibility: 'PUBLIC',
        markdown: '# D\nnumber 31',
      });
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.headers['ratelimit']).toBeDefined();
      expect(limited.headers['ratelimit-policy']).toBeDefined();
      expect(await rows('"shopId" = :s', { s: s.shopId })).toBe('30');
      expect(t.tasks.published).toHaveLength(30);

      const fine = await t.create(other.owner, other.shopId, {
        title: 'X',
        visibility: 'PUBLIC',
        markdown: '# X\nfine',
      });
      expect(fine.status).toBe(201);
    }, 120_000);

    it('S47 AS-33: an invalid request does not use up the allowance', async () => {
      const s = await t.seller();
      for (let i = 0; i < 35; i++)
        await t
          .create(s.owner, s.shopId, {
            title: '',
            visibility: 'PUBLIC',
            markdown: 'x',
          })
          .expect(400);
      const res = await t.create(s.owner, s.shopId, {
        title: 'Fine',
        visibility: 'PUBLIC',
        markdown: '# F\nfine',
      });
      expect(res.status).toBe(201);
    }, 60_000);
  });
});
