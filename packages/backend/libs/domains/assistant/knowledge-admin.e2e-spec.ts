import { v7 as uuidv7 } from 'uuid';
import {
  knowledgeCreateResponseSchema,
  knowledgeDocumentPageSchema,
} from '@marketplace-sandbox/contracts';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { minimalPdf } from '@app/test/utils/minimal-pdf';
import { KnowledgeSearchService } from './application/knowledge-search.service';
import { SweepService } from './application/sweep.service';
import { KnowledgeSweepJobs } from './infra/knowledge-sweep.jobs';
import {
  createKnowledgeApp,
  ESIM_MANUAL,
  sha256,
  type KnowledgeTestApp,
  type Seller,
} from './testing/knowledge.fixtures';

const admin = '/api/admin/knowledge';
const docs = (shopId: string) => `/api/shops/${shopId}/knowledge/documents`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`condition not met within ${ms} ms`);
}

describe('RAG: platform articles, re-index and sweeps', () => {
  let t: KnowledgeTestApp;

  beforeAll(async () => {
    t = await createKnowledgeApp();
  }, 180_000);
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const search = (shopId: string, question: string, k = 20) =>
    t.app
      .get(KnowledgeSearchService)
      .search({ kind: 'shop', shopId }, question, { k });
  const sql = (statement: string, replacements: Record<string, unknown> = {}) =>
    t.db.query(statement, { replacements });
  const rowOf = async (id: string) => (await t.document(id)) ?? null;

  describe('S47 AS-40: platform documents', () => {
    it('S47 AS-40: an administrator creates, lists and deletes platform articles; the same bytes twice are one document', async () => {
      const root = await t.admin();
      const body = {
        title: 'Seller guide',
        markdown: '# Payouts\nPayouts are sent every Monday.',
      };

      const created = await t.as(root).post(`${admin}/documents`).send(body);
      expect(created.status).toBe(201);
      const parsed = knowledgeCreateResponseSchema.parse(created.body);
      expect(parsed.document).toMatchObject({
        visibility: 'PLATFORM',
        productId: null,
        format: 'MARKDOWN',
        status: 'QUEUED',
      });
      expect(t.tasks.count(parsed.document.id)).toBe(1);
      expect((await t.document(parsed.document.id))!.shopId).toBeNull();

      const again = await t
        .as(root)
        .post(`${admin}/documents`)
        .send({ ...body, title: 'Other title' });
      expect(again.status).toBe(200);
      expect(again.body.deduplicated).toBe(true);
      expect(again.body.document.id).toBe(parsed.document.id);

      await t.ingest(parsed.document.id);
      const page = await t.as(root).get(`${admin}/documents`).expect(200);
      expect(
        knowledgeDocumentPageSchema.parse(page.body).items.map((d) => d.id),
      ).toEqual([parsed.document.id]);

      await t
        .as(root)
        .delete(`${admin}/documents/${parsed.document.id}`)
        .expect(204);
      await t
        .as(root)
        .get(`${admin}/documents/${parsed.document.id}`)
        .expect(404);
      await t
        .as(root)
        .delete(`${admin}/documents/${parsed.document.id}`)
        .expect(404);
      expect(
        (await t.as(root).get(`${admin}/documents`).expect(200)).body.items,
      ).toEqual([]);
      expect(await t.chunks(parsed.document.id)).toEqual([]);
    });

    it('S47 AS-40: the PDF form works on the admin routes', async () => {
      const root = await t.admin();
      const pdf = minimalPdf([['1 Payouts', 'Payouts are sent every Monday.']]);
      const created = await t
        .as(root)
        .post(`${admin}/documents`)
        .send({
          title: 'Payout guide',
          pdfSha256: sha256(pdf),
          pdfSize: pdf.length,
        });
      expect(created.status).toBe(201);
      expect(created.body.document).toMatchObject({
        status: 'AWAITING_UPLOAD',
        format: 'PDF',
        visibility: 'PLATFORM',
      });
      expect(created.body.upload.url).toBeTruthy();
      const id = created.body.document.id as string;
      await t.as(root).post(`${admin}/documents/${id}/uploaded`).expect(409); // no bytes yet
      await t.app
        .get(ObjectStorage)
        .put((await t.document(id))!.storageKey, pdf, 'application/pdf');
      await t.as(root).post(`${admin}/documents/${id}/uploaded`).expect(200);
      await t.ingest(id);
      expect((await t.document(id))!).toMatchObject({
        status: 'READY',
        chunkCount: 1,
      });
    });

    it('S47 AS-40: shop routes answer 404 for a platform document’s id and admin routes 404 for a shop document’s id', async () => {
      const root = await t.admin();
      const s = await t.seller();
      const article = await t.platformArticle(
        root,
        'Seller guide',
        '# Payouts\nPayouts are sent every Monday.',
      );
      const own = await t.index(s, 'Manual', ESIM_MANUAL);

      for (const res of await Promise.all([
        t.as(s.owner).get(`${docs(s.shopId)}/${article}`),
        t.as(s.owner).delete(`${docs(s.shopId)}/${article}`),
        t.as(s.owner).post(`${docs(s.shopId)}/${article}/uploaded`),
        t.as(s.owner).post(`${docs(s.shopId)}/${article}/retry`),
        t.as(root).get(`${admin}/documents/${own}`),
        t.as(root).delete(`${admin}/documents/${own}`),
        t.as(root).post(`${admin}/documents/${own}/uploaded`),
      ]))
        expect(res.status).toBe(404);
      expect((await t.document(article))!.status).toBe('READY');
      expect((await t.document(own))!.status).toBe('READY');
      const list = await t.as(s.owner).get(docs(s.shopId)).expect(200);
      expect(list.body.items.map((d: { id: string }) => d.id)).toEqual([own]);
    });

    it('S47 AS-40: every shop’s help center sees a platform article; a buyer never does', async () => {
      const root = await t.admin();
      const a = await t.seller();
      const b = await t.seller();
      await t.platformArticle(
        root,
        'Seller guide',
        '# Payouts\nPayouts are sent every Monday.',
      );

      for (const s of [a, b])
        expect(
          (await search(s.shopId, 'when are payouts sent')).items.map(
            (i) => i.title,
          ),
        ).toContain('Seller guide');
      const buyer = await t.app
        .get(KnowledgeSearchService)
        .search(
          { kind: 'product', productId: a.product.id, shopId: a.shopId },
          'when are payouts sent',
        );
      expect(buyer.items).toEqual([]);
    });
  });

  describe('S47 AS-41: embedding model change', () => {
    let s: Seller;
    const M2 = 'hashing-v2';
    beforeEach(async () => {
      s = await t.seller();
      t.config.set('rag_min_similarity', 0);
    });

    it('S47 AS-41: passages of the old model leave the meaning search but stay findable by keywords', async () => {
      const oldDoc = await t.index(
        s,
        'Old manual',
        '# Battery\nThe battery lasts all day with wired charging.',
      );
      t.embedder.model = M2;
      const newDoc = await t.index(
        s,
        'New manual',
        '# Battery\nThe battery charges wirelessly on a pad.',
      );

      const result = await search(s.shopId, 'battery');
      const byTitle = Object.fromEntries(result.items.map((i) => [i.title, i]));
      expect(result.mode).toBe('hybrid');
      expect(byTitle['New manual'].similarity).not.toBeNull(); // M2 passage: meaning search sees it
      expect(byTitle['Old manual']).toBeDefined(); // M1 passage: keywords still find it
      expect(byTitle['Old manual'].similarity).toBeNull(); // …but the meaning search no longer does
      expect((await t.chunks(oldDoc))[0].embeddingModel).toBe('hashing-1024');
      expect((await t.chunks(newDoc))[0].embeddingModel).toBe(M2);
    });

    it('S47 AS-41: re-index enqueues each stale READY document once, a second call enqueues none, a non-administrator is 403', async () => {
      const root = await t.admin();
      const ids = [
        await t.index(s, 'One', '# One\nfirst manual text'),
        await t.index(s, 'Two', '# Two\nsecond manual text'),
        await t.index(s, 'Three', '# Three\nthird manual text'),
      ];
      const article = await t.platformArticle(
        root,
        'Guide',
        '# Guide\nplatform guide text',
      );
      t.embedder.model = M2;
      t.tasks.reset();

      const first = await t.as(root).post(`${admin}/reindex`);
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ enqueued: 4 });
      for (const id of [...ids, article]) {
        expect(t.tasks.count(id)).toBe(1);
        expect((await rowOf(id))!.status).toBe('QUEUED');
        expect((await rowOf(id))!.chunkCount).toBe(1); // the old passages still serve
      }
      const second = await t.as(root).post(`${admin}/reindex`);
      expect(second.status).toBe(202);
      expect(second.body).toEqual({ enqueued: 0 });
      expect(t.tasks.published).toHaveLength(4);

      const forbidden = await t.as(s.owner).post(`${admin}/reindex`);
      expect(forbidden.status).toBe(403);
      expect(t.tasks.published).toHaveLength(4);

      for (const id of [...ids, article]) await t.ingest(id);
      for (const id of [...ids, article]) {
        expect((await rowOf(id))!).toMatchObject({
          status: 'READY',
          embeddingModel: M2,
        });
        expect((await t.chunks(id)).every((c) => c.embeddingModel === M2)).toBe(
          true,
        );
      }
      const third = await t.as(root).post(`${admin}/reindex`);
      expect(third.body).toEqual({ enqueued: 0 });
    });

    it('S47 AS-41: during re-embedding the old passages keep answering; the swap leaves all of the old or all of the new', async () => {
      const id = await t.index(s, 'Manual', ESIM_MANUAL);
      const before = (await t.chunks(id)).map((c) => c.id).sort();
      expect(before).toHaveLength(2);
      await sql(
        `UPDATE "KnowledgeDocument" SET status = 'QUEUED', "queuedAt" = now() WHERE id = :id`,
        { id },
      );

      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const inner = t.embedder.embed.bind(t.embedder);
      const spy = jest
        .spyOn(t.embedder, 'embed')
        .mockImplementation(async (texts, options) => {
          if (options.kind === 'document') await gate;
          return inner(texts, options);
        });
      const pass = t.ingest(id);
      await until(() => spy.mock.calls.some(([, o]) => o.kind === 'document'));

      const during = await search(s.shopId, 'pixel battery connectivity wifi');
      expect(during.items.map((i) => i.documentId)).toContain(id);
      expect(during.items.map((i) => i.id).sort()).toEqual(before);

      // Questions asked while the swap commits: each sees one complete generation of the document.
      const observed: string[][] = [];
      let swapping = true;
      const reader = (async () => {
        while (swapping) {
          const r = await search(s.shopId, 'pixel battery connectivity wifi');
          observed.push(
            r.items
              .filter((i) => i.documentId === id)
              .map((i) => i.id)
              .sort(),
          );
        }
      })();
      release();
      await pass;
      swapping = false;
      await reader;
      spy.mockRestore();

      const after = (await t.chunks(id)).map((c) => c.id).sort();
      expect(after).toHaveLength(2);
      expect(after).not.toEqual(before);
      expect(observed.length).toBeGreaterThan(0);
      for (const seen of observed) expect([before, after]).toContainEqual(seen);
    }, 60_000);
  });

  describe('S47 AS-42: sweeps', () => {
    const sweep = () => t.app.get(SweepService);
    const pdfDocument = async (s: Seller, marker: string) => {
      const pdf = minimalPdf([[`Page text ${marker} ${uuidv7()}`]]);
      const res = await t.create(s.owner, s.shopId, {
        title: `PDF ${marker}`,
        visibility: 'PUBLIC',
        pdfSha256: sha256(pdf),
        pdfSize: pdf.length,
      });
      const id = res.body.document.id as string;
      await t.app
        .get(ObjectStorage)
        .put((await t.document(id))!.storageKey, pdf, 'application/pdf');
      return id;
    };

    it('S47 AS-42: an upload abandoned for over 24 h is deleted with its bytes removed; a recent one stays', async () => {
      const s = await t.seller();
      const old = await pdfDocument(s, 'old');
      const fresh = await pdfDocument(s, 'fresh');
      const key = (await t.document(old))!.storageKey as string;
      await sql(
        `UPDATE "KnowledgeDocument" SET "createdAt" = now() - interval '25 hours' WHERE id = :id`,
        { id: old },
      );

      const report = await sweep().run();

      expect(report.abandonedUploads).toBe(1);
      expect(await rowOf(old)).toMatchObject({ status: 'DELETED', title: '' });
      expect((await rowOf(old))!.bytesRemovedAt).not.toBeNull();
      expect(await t.app.get(ObjectStorage).head(key)).toBeNull();
      expect((await rowOf(fresh))!.status).toBe('AWAITING_UPLOAD');
      await t
        .as(s.owner)
        .get(`${docs(s.shopId)}/${old}`)
        .expect(404);
    });

    it('S47 AS-42: a document QUEUED for over 5 minutes with no live task gets one new task; a second run adds none', async () => {
      const s = await t.seller();
      const lost = await t.markdown(
        s,
        'Lost',
        '# Lost\nthe enqueue after the insert was lost',
      );
      const recent = await t.markdown(s, 'Recent', '# Recent\njust queued');
      t.tasks.reset();
      await sql(
        `UPDATE "KnowledgeDocument" SET "queuedAt" = now() - interval '6 minutes' WHERE id = :id`,
        { id: lost },
      );

      const first = await sweep().run();
      expect(first.requeued).toBe(1);
      expect(t.tasks.count(lost)).toBe(1);
      expect(t.tasks.count(recent)).toBe(0);
      const second = await sweep().run();
      expect(second.requeued).toBe(0);
      expect(t.tasks.count(lost)).toBe(1);
    });

    it('S47 AS-42: a processing lease that expired returns the document to QUEUED with one task', async () => {
      const s = await t.seller();
      const id = await t.markdown(
        s,
        'Stuck',
        '# Stuck\nthe worker died holding the claim',
      );
      t.tasks.reset();
      await sql(
        `UPDATE "KnowledgeDocument" SET status = 'PROCESSING', "leaseToken" = :token, "leaseUntil" = now() - interval '1 minute' WHERE id = :id`,
        { id, token: uuidv7() },
      );

      const report = await sweep().run();

      expect(report.leasesReleased).toBe(1);
      expect(await rowOf(id)).toMatchObject({
        status: 'QUEUED',
        leaseToken: null,
      });
      expect(t.tasks.count(id)).toBe(1);
      await t.ingest(id); // and the redelivery completes it
      expect((await rowOf(id))!.status).toBe('READY');
    });

    it('S47 AS-42: a live lease is left alone', async () => {
      const s = await t.seller();
      const id = await t.markdown(s, 'Busy', '# Busy\na worker is on it');
      t.tasks.reset();
      await sql(
        `UPDATE "KnowledgeDocument" SET status = 'PROCESSING', "leaseToken" = :token, "leaseUntil" = now() + interval '4 minutes' WHERE id = :id`,
        { id, token: uuidv7() },
      );
      const report = await sweep().run();
      expect(report.leasesReleased).toBe(0);
      expect((await rowOf(id))!.status).toBe('PROCESSING');
      expect(t.tasks.published).toEqual([]);
    });

    it('S47 AS-42: tombstones older than 30 days are purged; younger ones stay; bytes whose removal failed are retried', async () => {
      const s = await t.seller();
      const oldId = await t.index(s, 'Old', '# Old\nold text');
      const youngId = await t.index(s, 'Young', '# Young\nyoung text');
      const orphanId = await t.index(s, 'Orphan', '# Orphan\norphan text');
      const orphanKey = (await t.document(orphanId))!.storageKey as string;
      for (const id of [oldId, youngId])
        await t
          .as(s.owner)
          .delete(`${docs(s.shopId)}/${id}`)
          .expect(204);
      await sql(
        `UPDATE "KnowledgeDocument" SET "deletedAt" = now() - interval '31 days' WHERE id = :id`,
        { id: oldId },
      );
      await sql(
        `UPDATE "KnowledgeDocument" SET "deletedAt" = now() - interval '10 days' WHERE id = :id`,
        { id: youngId },
      );
      // A delete whose byte removal failed: DELETED, bytes still stored, not yet marked removed.
      await sql(
        `UPDATE "KnowledgeDocument" SET status = 'DELETED', title = '', "chunkCount" = 0, "deletedAt" = now(), "bytesRemovedAt" = NULL WHERE id = :id`,
        { id: orphanId },
      );
      await sql(`DELETE FROM "KnowledgeChunk" WHERE "documentId" = :id`, {
        id: orphanId,
      });
      expect(await t.app.get(ObjectStorage).head(orphanKey)).not.toBeNull();

      const report = await sweep().run();

      expect(report.tombstonesPurged).toBe(1);
      expect(await rowOf(oldId)).toBeNull();
      expect(await rowOf(youngId)).not.toBeNull();
      expect(report.bytesRemoved).toBe(1);
      expect(await t.app.get(ObjectStorage).head(orphanKey)).toBeNull();
      expect((await rowOf(orphanId))!.bytesRemovedAt).not.toBeNull();
    });

    it('S47 AS-42: two runs at once do the work once; a second run in a row changes nothing', async () => {
      const s = await t.seller();
      const lost = await t.markdown(s, 'Lost', '# Lost\nlost enqueue');
      const stuck = await t.markdown(s, 'Stuck', '# Stuck\nstuck lease');
      const abandoned = await pdfDocument(s, 'abandoned');
      t.tasks.reset();
      await sql(
        `UPDATE "KnowledgeDocument" SET "queuedAt" = now() - interval '6 minutes' WHERE id = :id`,
        { id: lost },
      );
      await sql(
        `UPDATE "KnowledgeDocument" SET status = 'PROCESSING', "leaseToken" = :token, "leaseUntil" = now() - interval '1 minute' WHERE id = :id`,
        { id: stuck, token: uuidv7() },
      );
      await sql(
        `UPDATE "KnowledgeDocument" SET "createdAt" = now() - interval '25 hours' WHERE id = :id`,
        { id: abandoned },
      );

      const reports = await Promise.all([sweep().run(), sweep().run()]);

      expect(reports.reduce((n, r) => n + r.requeued, 0)).toBe(1);
      expect(reports.reduce((n, r) => n + r.leasesReleased, 0)).toBe(1);
      expect(reports.reduce((n, r) => n + r.abandonedUploads, 0)).toBe(1);
      expect(t.tasks.count(lost)).toBe(1);
      expect(t.tasks.count(stuck)).toBe(1);
      const before = await t.db.query(
        `SELECT id, status, "queuedAt", "bytesRemovedAt" FROM "KnowledgeDocument" ORDER BY id`,
      );
      const again = await sweep().run();
      expect(again).toEqual({
        abandonedUploads: 0,
        requeued: 0,
        leasesReleased: 0,
        bytesRemoved: 0,
        tombstonesPurged: 0,
      });
      expect(
        await t.db.query(
          `SELECT id, status, "queuedAt", "bytesRemovedAt" FROM "KnowledgeDocument" ORDER BY id`,
        ),
      ).toEqual(before);
      expect(t.tasks.published).toHaveLength(2);
    });

    it('S47 AS-42: the scheduled job runs the same sweep', async () => {
      const s = await t.seller();
      const lost = await t.markdown(s, 'Lost', '# Lost\nlost enqueue');
      t.tasks.reset();
      await sql(
        `UPDATE "KnowledgeDocument" SET "queuedAt" = now() - interval '6 minutes' WHERE id = :id`,
        { id: lost },
      );
      const report = await t.app.get(KnowledgeSweepJobs).run();
      expect(report.requeued).toBe(1);
      expect(t.tasks.count(lost)).toBe(1);
    });
  });
});
