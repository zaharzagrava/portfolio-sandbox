import { v7 as uuidv7 } from 'uuid';
import { ProductDeleted } from '@app/domains/catalog';
import { ShopDeleted } from '@app/domains/tenancy';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { readTopic, testKafka } from '@app/test/utils/kafka-test';
import { LifecycleService } from './application/lifecycle.service';
import { minimalPdf } from '@app/test/utils/minimal-pdf';
import {
  createKnowledgeApp,
  ESIM_MANUAL,
  sha256,
  type KnowledgeTestApp,
  type Seller,
} from './testing/knowledge.fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 45_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`condition not met within ${ms} ms`);
}

describe('RAG: product and shop deletion consumers', () => {
  let t: KnowledgeTestApp;

  beforeAll(async () => {
    t = await createKnowledgeApp({ consumers: true });
  }, 180_000);
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const deliver = async (
    topic: string,
    messages: { key: string; value: unknown }[],
  ) => {
    const producer = testKafka().producer();
    await producer.connect();
    try {
      await producer.send({
        topic,
        messages: messages.map((m) => ({
          key: m.key,
          value:
            typeof m.value === 'string' ? m.value : JSON.stringify(m.value),
        })),
      });
    } finally {
      await producer.disconnect();
    }
  };
  const productDeleted = (productId: string, shopId: string, version = 7) =>
    ProductDeleted.create(productId, version, {
      productId,
      shopId,
      productVersion: version,
    });
  const shopDeleted = (shopId: string) =>
    ShopDeleted.create(shopId, 3, { shopId, shopVersion: 3 });
  const status = async (id: string) => (await t.document(id))!.status as string;
  const storage = () => t.app.get(ObjectStorage);
  const queuedPdf = async (s: Seller) => {
    const pdf = minimalPdf([[`Awaiting ${uuidv7()}`]]);
    const res = await t.create(s.owner, s.shopId, {
      title: 'Awaiting',
      visibility: 'PUBLIC',
      productId: s.product.id,
      pdfSha256: sha256(pdf),
      pdfSize: pdf.length,
    });
    const id = res.body.document.id as string;
    await storage().put(
      (await t.document(id))!.storageKey,
      pdf,
      'application/pdf',
    );
    return id;
  };

  describe('S47 AS-50: product deleted', () => {
    it('S47 AS-50: both documents of the product are deleted with their passages and bytes; other documents of the shop are unchanged; a duplicate is a single effect', async () => {
      const s = await t.seller();
      const ready = await t.index(s, 'Manual', ESIM_MANUAL, {
        productId: s.product.id,
      });
      const queued = await t.markdown(s, 'Queued', '# Q\nqueued text', {
        productId: s.product.id,
      });
      const other = await t.index(s, 'Shop FAQ', '# FAQ\nshop level text');
      const readyKey = (await t.document(ready))!.storageKey as string;
      const event = productDeleted(s.product.id, s.shopId);
      const marker = await t.seller();
      const markerDoc = await t.index(marker, 'Marker', '# M\nmarker text', {
        productId: marker.product.id,
      });

      await deliver(ProductDeleted.topic, [
        { key: s.product.id, value: event },
      ]);
      await until(
        async () =>
          (await status(ready)) === 'DELETED' &&
          (await status(queued)) === 'DELETED',
      );
      const afterFirst = await Promise.all(
        [ready, queued].map((id) => t.document(id)),
      );

      await deliver(ProductDeleted.topic, [
        { key: s.product.id, value: event }, // the same eventId again
        {
          key: marker.product.id,
          value: productDeleted(marker.product.id, marker.shopId),
        },
      ]);
      await until(async () => (await status(markerDoc)) === 'DELETED'); // the marker is behind the duplicate in the log
      const afterDuplicate = await Promise.all(
        [ready, queued].map((id) => t.document(id)),
      );
      expect(afterDuplicate).toEqual(afterFirst); // a single effect: nothing moved, not even a timestamp

      for (const id of [ready, queued]) {
        const row = (await t.document(id))!;
        expect(row).toMatchObject({
          status: 'DELETED',
          chunkCount: 0,
          title: '',
        });
        expect(await t.chunks(id)).toEqual([]);
        expect(row.bytesRemovedAt).not.toBeNull();
      }
      expect(await storage().head(readyKey)).toBeNull();
      expect(await status(other)).toBe('READY');
      expect((await t.chunks(other)).length).toBeGreaterThan(0);
      expect((await t.document(ready))!.deletedAt).not.toBeNull();
      await t
        .as(s.owner)
        .get(`/api/shops/${s.shopId}/knowledge/documents/${ready}`)
        .expect(404);
    }, 90_000);

    it('S47 AS-50: an event for a product without documents is a no-op', async () => {
      const s = await t.seller();
      const other = await t.index(s, 'FAQ', '# FAQ\nshop level text');
      const marker = await t.seller();
      const markerDoc = await t.index(marker, 'Marker', '# M\nmarker text', {
        productId: marker.product.id,
      });
      await deliver(ProductDeleted.topic, [
        { key: s.product.id, value: productDeleted(s.product.id, s.shopId) },
        {
          key: marker.product.id,
          value: productDeleted(marker.product.id, marker.shopId),
        },
      ]);
      await until(async () => (await status(markerDoc)) === 'DELETED');
      expect(await status(other)).toBe('READY');
    }, 90_000);

    it('S47 AS-50: a document still being ingested when the purge arrives ends DELETED with no passages', async () => {
      const s = await t.seller();
      const id = await t.markdown(s, 'Manual', ESIM_MANUAL, {
        productId: s.product.id,
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const inner = t.embedder.embed.bind(t.embedder);
      const spy = jest
        .spyOn(t.embedder, 'embed')
        .mockImplementation(async (texts, o) => {
          await gate;
          return inner(texts, o);
        });
      const pass = t.ingest(id);
      await until(() => spy.mock.calls.length === 1);

      expect(
        await t.app.get(LifecycleService).purgeByProduct(s.product.id),
      ).toBe(1);
      release();
      await pass;

      expect(await status(id)).toBe('DELETED');
      expect(await t.chunks(id)).toEqual([]);
      expect(
        await t.app.get(LifecycleService).purgeByProduct(s.product.id),
      ).toBe(0); // repeating finds nothing
      spy.mockRestore();
    });
  });

  describe('S47 AS-51: shop deleted', () => {
    it('S47 AS-51: every document of the shop is purged whatever its status; another shop and the platform are untouched; a duplicate has no further effect', async () => {
      const root = await t.admin();
      const a = await t.seller();
      const b = await t.seller();
      const platform = await t.platformArticle(
        root,
        'Guide',
        '# G\nplatform text',
      );
      const bDoc = await t.index(b, 'B manual', ESIM_MANUAL);
      const ids = {
        ready: await t.index(a, 'Ready', '# R\nready text'),
        queued: await t.markdown(a, 'Queued', '# Q\nqueued text'),
        awaiting: await queuedPdf(a),
        processing: await t.markdown(a, 'Processing', '# P\nprocessing text'),
        failed: await t.markdown(a, 'Failed', '# F\nfailed text'),
        deleted: await t.markdown(a, 'Deleted', '# D\ndeleted text'),
      };
      await t.db.query(
        `UPDATE "KnowledgeDocument" SET status = 'PROCESSING', "leaseToken" = :token, "leaseUntil" = now() + interval '5 minutes' WHERE id = :id`,
        {
          replacements: { id: ids.processing, token: uuidv7() },
        },
      );
      await t.db.query(
        `UPDATE "KnowledgeDocument" SET status = 'FAILED', "failureCode" = 'unparseable' WHERE id = :id`,
        {
          replacements: { id: ids.failed },
        },
      );
      await t
        .as(a.owner)
        .delete(`/api/shops/${a.shopId}/knowledge/documents/${ids.deleted}`)
        .expect(204);
      const marker = await t.seller();
      const markerDoc = await t.index(marker, 'Marker', '# M\nmarker text');
      const event = shopDeleted(a.shopId);

      await deliver(ShopDeleted.topic, [
        { key: a.shopId, value: event },
        { key: a.shopId, value: event },
        { key: marker.shopId, value: shopDeleted(marker.shopId) },
      ]);
      await until(async () => (await status(markerDoc)) === 'DELETED');

      for (const id of Object.values(ids)) {
        expect(await status(id)).toBe('DELETED');
        expect(await t.chunks(id)).toEqual([]);
      }
      expect(await status(platform)).toBe('READY');
      expect(await status(bDoc)).toBe('READY');
      expect((await t.chunks(bDoc)).length).toBeGreaterThan(0);
      expect((await t.chunks(platform)).length).toBeGreaterThan(0);
    }, 90_000);
  });

  describe('S47 AS-52: invalid event payloads are dead-lettered and block nothing', () => {
    const envelope = (
      over: Record<string, unknown>,
      payload?: Record<string, unknown>,
    ) => {
      const base = productDeleted(uuidv7(), uuidv7());
      return {
        ...base,
        eventId: uuidv7(),
        ...over,
        payload: payload ?? base.payload,
      };
    };
    const shopEnvelope = (
      over: Record<string, unknown>,
      payload?: Record<string, unknown>,
    ) => {
      const base = shopDeleted(uuidv7());
      return {
        ...base,
        eventId: uuidv7(),
        ...over,
        payload: payload ?? base.payload,
      };
    };

    it.each([
      [
        'productId missing',
        () => envelope({}, { shopId: uuidv7(), productVersion: 1 }),
      ],
      [
        'productId not a UUID',
        () =>
          envelope(
            {},
            { productId: 'not-a-uuid', shopId: uuidv7(), productVersion: 1 },
          ),
      ],
      [
        'aggregate id not a UUID',
        () => envelope({ aggregateId: 'not-a-uuid' }),
      ],
      ['a version the consumer does not know', () => envelope({ version: 2 })],
      ['not JSON', () => 'this is not json'],
    ])(
      'S47 AS-52: product_deleted with %s goes to the dead-letter topic and the next message is processed',
      async (_name, make) => {
        const marker = uuidv7();
        const s = await t.seller();
        const doc = await t.index(s, 'Manual', ESIM_MANUAL, {
          productId: s.product.id,
        });

        await deliver(ProductDeleted.topic, [
          { key: marker, value: make() },
          { key: s.product.id, value: productDeleted(s.product.id, s.shopId) },
        ]);

        await until(async () => (await status(doc)) === 'DELETED');
        await until(async () =>
          (await readTopic('knowledge-product-deleted.dlq')).some(
            (m) => m.key === marker,
          ),
        );
      },
      90_000,
    );

    it.each([
      ['shopId missing', () => shopEnvelope({}, { shopVersion: 1 })],
      [
        'shopId not a UUID',
        () => shopEnvelope({}, { shopId: 'nope', shopVersion: 1 }),
      ],
      [
        'aggregate id not a UUID',
        () => shopEnvelope({ aggregateId: 'not-a-uuid' }),
      ],
      [
        'a version the consumer does not know',
        () => shopEnvelope({ version: 2 }),
      ],
      ['not JSON', () => '{broken'],
    ])(
      'S47 AS-52: shop_deleted with %s goes to the dead-letter topic and the next message is processed',
      async (_name, make) => {
        const marker = uuidv7();
        const s = await t.seller();
        const doc = await t.index(s, 'Manual', ESIM_MANUAL);

        await deliver(ShopDeleted.topic, [
          { key: marker, value: make() },
          { key: s.shopId, value: shopDeleted(s.shopId) },
        ]);

        await until(async () => (await status(doc)) === 'DELETED');
        await until(async () =>
          (await readTopic('knowledge-shop-deleted.dlq')).some(
            (m) => m.key === marker,
          ),
        );
      },
      90_000,
    );
  });
});
