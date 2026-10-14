import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryTypes } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { minimalPdf } from '@app/test/utils/minimal-pdf';
import { IngestService } from './application/ingest.service';
import { KnowledgeSearchService } from './application/knowledge-search.service';
import {
  createKnowledgeApp,
  ESIM_MANUAL,
  sha256,
  type KnowledgeTestApp,
  type Seller,
} from './testing/knowledge.fixtures';

const ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:9424';
const PREFIX =
  process.env.SQS_QUEUE_URL_PREFIX ?? 'http://localhost:9424/000000000000/';
const sqs = new SQSClient({
  region: 'eu-central-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const docs = (shopId: string) => `/api/shops/${shopId}/knowledge/documents`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`condition not met within ${ms} ms`);
}

/** Removes (and returns the bodies of) what is on the dead-letter queue, so a run leaves the shared queue as it found it. */
async function drainDlq(): Promise<{ body: string; reason?: string }[]> {
  const seen: { body: string; reason?: string }[] = [];
  for (let i = 0; i < 5; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: `${PREFIX}knowledge-ingest-dlq`,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    if (!Messages.length) break;
    for (const m of Messages) {
      seen.push({
        body: m.Body!,
        reason: m.MessageAttributes?.deadLetterReason?.StringValue,
      });
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: `${PREFIX}knowledge-ingest-dlq`,
          ReceiptHandle: m.ReceiptHandle!,
        }),
      );
    }
  }
  return seen;
}

describe('RAG: ingestion pipeline (queue consumer)', () => {
  let t: KnowledgeTestApp;

  beforeAll(async () => {
    t = await createKnowledgeApp();
  }, 180_000);
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  const storage = () => t.app.get(ObjectStorage);
  const setStatus = (id: string, sql: string) =>
    t.db.query(`UPDATE "KnowledgeDocument" SET ${sql} WHERE id = :id`, {
      replacements: { id },
    });
  /** A PDF document created through the API, its bytes stored as the client's presigned PUT would, then `uploaded`. */
  const pdfDocument = async (
    s: Seller,
    pdf: Buffer,
    declared: { sha?: string; size?: number } = {},
  ) => {
    const res = await t.create(s.owner, s.shopId, {
      title: 'Pixel PDF',
      visibility: 'PUBLIC',
      productId: s.product.id,
      pdfSha256: declared.sha ?? sha256(pdf),
      pdfSize: declared.size ?? pdf.length,
    });
    expect(res.status).toBe(201);
    const id = res.body.document.id as string;
    await storage().put(
      (await t.document(id))!.storageKey,
      pdf,
      'application/pdf',
    );
    await t
      .as(s.owner)
      .post(`${docs(s.shopId)}/${id}/uploaded`)
      .expect(200);
    return id;
  };
  const get = async (s: Seller, id: string) =>
    (
      await t
        .as(s.owner)
        .get(`${docs(s.shopId)}/${id}`)
        .expect(200)
    ).body;

  it('S47 AS-15: markdown becomes passages with heading paths, embeddings and keyword entries, in 1–800 tokens, with the model recorded', async () => {
    const s = await t.seller();
    const id = await t.markdown(s, 'Pixel 10 manual', ESIM_MANUAL, {
      productId: s.product.id,
    });

    await t.ingest(id);

    const chunks = await t.chunks(id);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Pixel 10 manual > Connectivity',
      'Pixel 10 manual > Battery',
    ]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
    for (const c of chunks) {
      expect(c.has_embedding).toBe(true);
      expect(c.has_tsv).toBe(true);
      expect(c.tokens).toBeGreaterThanOrEqual(1);
      expect(c.tokens).toBeLessThanOrEqual(800);
      expect(c.embeddingModel).toBe('hashing-1024');
      expect(c).toMatchObject({
        shopId: s.shopId,
        productId: s.product.id,
        visibility: 'PUBLIC',
      });
    }
    const doc = (await t.document(id))!;
    expect(doc).toMatchObject({
      status: 'READY',
      chunkCount: 2,
      embeddingModel: 'hashing-1024',
      failureCode: null,
      leaseToken: null,
    });
    expect(doc.indexedHash).toBe(doc.contentHash);
    expect(
      t.metric('rag_ingest_total', { outcome: 'ready' }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('S47 AS-16: PDF pages and numbered headings survive into passages', async () => {
    const s = await t.seller();
    const pdf = minimalPdf([
      ['1 Getting started', 'Hold the power button for three seconds.'],
      [
        '2 Connectivity',
        '2.1 eSIM support',
        'The phone supports eSIM and dual SIM.',
      ],
    ]);
    const id = await pdfDocument(s, pdf);

    await t.ingest(id);

    const body = await get(s, id);
    expect(body).toMatchObject({
      status: 'READY',
      format: 'PDF',
      failureCode: null,
    });
    const chunks = await t.chunks(id);
    expect(chunks.find((c) => c.page === 2)).toMatchObject({
      headingPath: 'Pixel PDF > 2 Connectivity > 2.1 eSIM support',
    });
    expect(chunks.find((c) => c.page === 1)).toMatchObject({
      headingPath: 'Pixel PDF > 1 Getting started',
    });
    const found = await t.app
      .get(KnowledgeSearchService)
      .search(
        { kind: 'product', productId: s.product.id, shopId: s.shopId },
        'does it support esim',
      );
    expect(found.items[0]).toMatchObject({
      page: 2,
      headingPath: 'Pixel PDF > 2 Connectivity > 2.1 eSIM support',
    });
  });

  describe('S47 AS-24: poison input fails once with a code the seller can act on', () => {
    const manySections = Array.from(
      { length: 2_001 },
      (_, i) => `# P${i}\n## c\ntext ${i}`,
    ).join('\n');
    const cases: [string, FailureCase][] = [
      [
        'not_a_pdf',
        { make: () => Buffer.from('this is not a pdf at all, just words') },
      ],
      [
        'unparseable',
        { make: () => Buffer.from('%PDF-1.4 definitely not a pdf') },
      ],
      ['no_text', { make: () => minimalPdf([['']]) }],
      [
        'too_many_pages',
        {
          make: () => minimalPdf([['one'], ['two'], ['three']]),
          before: () => t.config.set('knowledge_max_pages', 2),
        },
      ],
      ['too_many_chunks', { markdown: manySections }],
      [
        'size_mismatch',
        {
          make: () => Buffer.from('%PDF-1.4 some bytes'),
          declared: { size: 99_999 },
        },
      ],
    ];
    interface FailureCase {
      make?: () => Buffer;
      markdown?: string;
      declared?: { sha?: string; size?: number };
      before?: () => void;
    }

    it.each(cases)(
      'S47 AS-24: %s → FAILED once, acknowledged, no passages, no internal text',
      async (code, c) => {
        const s = await t.seller();
        c.before?.();
        const id = c.markdown
          ? await t.markdown(s, 'Huge', c.markdown)
          : await pdfDocument(s, c.make!(), c.declared);

        await expect(t.ingest(id)).resolves.toBeUndefined(); // acknowledged: nothing for the queue to redeliver

        const body = await get(s, id);
        expect(body).toMatchObject({
          status: 'FAILED',
          failureCode: code,
          chunkCount: 0,
        });
        expect(JSON.stringify(body)).not.toMatch(
          /unpdf|pdf\.js|Invalid PDF|stack|knowledge\/|\.pdf|\.md/i,
        );
        expect(await t.chunks(id)).toEqual([]);
        const row = (await t.document(id))!;
        expect(row.leaseToken).toBeNull();
        // a redelivery is a no-op: the document is already FAILED, so it is not claimed again
        t.embedder.reset();
        await t.ingest(id, 2);
        expect(t.embedder.calls).toEqual([]);
        expect((await t.document(id))!.status).toBe('FAILED');
      },
    );

    it('S47 AS-24: bytes that differ from the declared hash are size_mismatch', async () => {
      const s = await t.seller();
      const stored = minimalPdf([['stored bytes']]);
      const other = minimalPdf([['declared bytes'], ['more']]);
      const id = await pdfDocument(s, stored, {
        sha: sha256(other),
        size: stored.length,
      });
      await t.ingest(id);
      expect(await get(s, id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'size_mismatch',
      });
    });
  });

  describe('S47 AS-25: transient failure, retry, dead letter', () => {
    it('S47 AS-25: the first two deliveries requeue the document, the third succeeds with one complete set of passages', async () => {
      const s = await t.seller();
      const id = await t.markdown(s, 'Manual', ESIM_MANUAL);
      t.embedder.failures = 2;

      await expect(t.ingest(id, 1)).rejects.toThrow();
      expect(await get(s, id)).toMatchObject({
        status: 'QUEUED',
        failureCode: null,
      });
      expect((await t.document(id))!.leaseToken).toBeNull();
      await expect(t.ingest(id, 2)).rejects.toThrow();
      expect((await get(s, id)).status).toBe('QUEUED');
      await t.ingest(id, 3);

      expect(await get(s, id)).toMatchObject({
        status: 'READY',
        chunkCount: 2,
      });
      expect(await t.chunks(id)).toHaveLength(2);
      expect(t.embedder.documentCalls).toHaveLength(3); // one call per delivery, no internal retry
    });

    it('S47 AS-25: the fifth receive ends FAILED(embedding_unavailable) and the previous passages stay searchable', async () => {
      const s = await t.seller();
      const id = await t.index(s, 'Pixel 10 manual', ESIM_MANUAL, {
        productId: s.product.id,
      });
      const before = (await t.chunks(id)).map((c) => c.id);
      await setStatus(id, `status = 'QUEUED', "queuedAt" = now()`); // a re-index in flight
      t.embedder.failures = Infinity;

      for (const receive of [1, 2, 3, 4]) {
        await expect(t.ingest(id, receive)).rejects.toThrow();
        expect((await get(s, id)).status).toBe('QUEUED');
      }
      await expect(t.ingest(id, 5)).rejects.toThrow(); // rethrown so the queue dead-letters the message

      expect(await get(s, id)).toMatchObject({
        status: 'FAILED',
        failureCode: 'embedding_unavailable',
        chunkCount: 2,
      });
      expect((await t.chunks(id)).map((c) => c.id)).toEqual(before);
      const found = await t.app
        .get(KnowledgeSearchService)
        .search(
          { kind: 'product', productId: s.product.id, shopId: s.shopId },
          'does it support esim',
        );
      expect(found.items.map((i) => i.documentId)).toContain(id);
      expect(
        t.metric('rag_ingest_total', { outcome: 'dead_lettered' }),
      ).toBeGreaterThanOrEqual(1);
    });

    it('S47 AS-25: the queue definition matches the configuration (L-002)', () => {
      const conf = readFileSync(
        resolve(
          __dirname,
          '../../../../../infra/docker/elasticmq/elasticmq.conf',
        ),
        'utf8',
      );
      expect(conf).toMatch(/knowledge-ingest-dlq \{\}/);
      const line = conf
        .split('\n')
        .find((l) => /^\s*knowledge-ingest \{/.test(l))!;
      expect(line).toContain(
        'deadLettersQueue { name = "knowledge-ingest-dlq"',
      );
      expect(Number(/maxReceiveCount = (\d+)/.exec(line)![1])).toBe(
        t.config.get('knowledge_max_receives'),
      );
      expect(
        Number(/defaultVisibilityTimeout = (\d+) seconds/.exec(line)![1]),
      ).toBe(t.config.get('knowledge_processing_lease_ms') / 1000);
    });
  });

  describe('S47 AS-26: redelivery and concurrent delivery', () => {
    it('S47 AS-26: a delivery for an indexed document is acknowledged with no effect and no embedding call', async () => {
      const s = await t.seller();
      const id = await t.index(s, 'Manual', ESIM_MANUAL);
      const before = (await t.chunks(id)).map((c) => c.id);
      t.embedder.reset();

      await t.ingest(id, 2);

      expect((await t.chunks(id)).map((c) => c.id)).toEqual(before);
      expect(t.embedder.calls).toEqual([]);
      expect((await t.document(id))!.status).toBe('READY');
    });

    it('S47 AS-26: two workers at the same moment embed once and leave one set of passages', async () => {
      const s = await t.seller();
      const id = await t.markdown(s, 'Manual', ESIM_MANUAL);

      await Promise.all([t.ingest(id), t.ingest(id)]);

      expect(t.embedder.documentCalls).toHaveLength(1);
      expect(await t.chunks(id)).toHaveLength(2);
      expect((await t.document(id))!.status).toBe('READY');
    });

    it('S47 AS-26: a live lease held elsewhere is left alone; an expired one is taken over', async () => {
      const s = await t.seller();
      const id = await t.markdown(s, 'Manual', ESIM_MANUAL);
      await setStatus(
        id,
        `status = 'PROCESSING', "leaseToken" = '${uuidv7()}', "leaseUntil" = now() + interval '4 minutes'`,
      );
      await t.ingest(id);
      expect(t.embedder.calls).toEqual([]);
      expect((await t.document(id))!.status).toBe('PROCESSING');

      await setStatus(id, `"leaseUntil" = now() - interval '1 minute'`); // the worker died holding the claim
      await t.ingest(id);
      expect(await get(s, id)).toMatchObject({
        status: 'READY',
        chunkCount: 2,
      });
      expect(t.embedder.documentCalls).toHaveLength(1);
    });
  });

  describe('S47 AS-27: invalid queue payloads (the real queue and consumer)', () => {
    const send = (body: string) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: `${PREFIX}knowledge-ingest`,
          MessageBody: body,
        }),
      );
    /**
     * The broker is shared by every run: a long poll left open by a consumer whose process has just exited (the previous
     * run) still collects one message for a client that is gone, and nobody handles it until its visibility timeout ends.
     * Probe until this process's consumer demonstrably handles a message, then send the real ones.
     */
    const awaitConsumer = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const probe = uuidv7();
        await send(JSON.stringify({ probe }));
        const end = Date.now() + 8_000;
        while (Date.now() < end)
          if ((await drainDlq()).some((d) => d.body.includes(probe))) return;
      }
      throw new Error(
        'the consumer of this process did not handle a probe message',
      );
    };

    it('S47 AS-27: bodies that are not {documentId: uuid} reach the dead-letter queue with no effect', async () => {
      await drainDlq();
      await awaitConsumer();
      const handled = jest.spyOn(t.app.get(IngestService), 'ingest');
      const marker = uuidv7();
      const bad = [
        JSON.stringify({ marker }),
        JSON.stringify({ documentId: 42, marker }),
        JSON.stringify({ data: { documentId: uuidv7() }, marker }),
        JSON.stringify({ documentId: 'not-a-uuid', marker }),
        JSON.stringify({ documentId: uuidv7(), extra: marker }),
        `not json ${marker}`,
      ];
      for (const body of bad) await send(body);

      const dead: { body: string; reason?: string }[] = [];
      await until(async () => {
        dead.push(...(await drainDlq()));
        return (
          dead.filter((d) => d.body.includes(marker)).length === bad.length
        );
      }, 40_000);

      expect(dead.every((d) => d.reason === 'SCHEMA_INVALID')).toBe(true);
      expect(handled).not.toHaveBeenCalled(); // the handler never saw any of them
      handled.mockRestore();
      expect(
        (
          await t.db.query(`SELECT 1 FROM "KnowledgeDocument"`, {
            type: QueryTypes.SELECT,
          })
        ).length,
      ).toBe(0);
    }, 60_000);

    it('S47 AS-27: a task for an unknown document is acknowledged with no effect', async () => {
      const before = t.metric('rag_ingest_total', { outcome: 'noop' });
      await send(JSON.stringify({ documentId: uuidv7() }));
      await until(
        () => t.metric('rag_ingest_total', { outcome: 'noop' }) > before,
        30_000,
      );
      expect(await drainDlq()).toEqual([]);
    }, 45_000);

    it('S47 AS-27: a task for a deleted document is a no-op', async () => {
      const s = await t.seller();
      const id = await t.index(s, 'Manual', ESIM_MANUAL);
      await t
        .as(s.owner)
        .delete(`${docs(s.shopId)}/${id}`)
        .expect(204);
      t.embedder.reset();
      await t.ingest(id);
      expect(t.embedder.calls).toEqual([]);
      expect((await t.document(id))!.status).toBe('DELETED');
      expect(await t.chunks(id)).toEqual([]);
    });
  });

  it('S47 AS-29: a document deleted while its embeddings are being computed stays DELETED with no passages', async () => {
    const s = await t.seller();
    const id = await t.markdown(s, 'Manual', ESIM_MANUAL);
    // The embedder answers only when released: the pass is in its embedding step while the delete happens.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = t.embedder.embed.bind(t.embedder);
    const spy = jest
      .spyOn(t.embedder, 'embed')
      .mockImplementation(async (texts, options) => {
        await gate;
        return inner(texts, options);
      });
    const pass = t.ingest(id);
    await until(() => spy.mock.calls.length === 1);

    await t
      .as(s.owner)
      .delete(`${docs(s.shopId)}/${id}`)
      .expect(204);
    release();
    await expect(pass).resolves.toBeUndefined(); // acknowledged

    const row = (await t.document(id))!;
    expect(row.status).toBe('DELETED');
    expect(row.chunkCount).toBe(0);
    expect(await t.chunks(id)).toEqual([]);
    spy.mockRestore();
  });
});
