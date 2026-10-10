import { INestApplication, Module } from '@nestjs/common';
import {
  getConnectionToken,
  getModelToken,
  SequelizeModule,
} from '@nestjs/sequelize';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { QueryTypes, Sequelize } from 'sequelize';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { readSse, SseEvent } from '@app/test/utils/sse-client';
import { minimalPdf } from '@app/test/utils/minimal-pdf';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { AuthApiModule, UserModel as User } from '@app/domains/identity';
import { issueSession } from '@app/test/seeds/session.fixture';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import {
  ShopModel as Shop,
  ShopMembershipModel as ShopMembership,
} from '@app/domains/tenancy';
import { LLM_PROVIDER } from './infra/llm/llm-provider';
import { ScriptedLlmProvider } from './infra/llm/scripted.provider';
import { ApiConfigService } from '@app/common/config';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { KnowledgeModule } from './knowledge.module';
import { KnowledgeService } from './application/knowledge.service';
import { Retriever } from './infra/retriever';

@Module({
  imports: [
    KnowledgeModule,
    SequelizeModule.forFeature([Shop, ShopMembership]),
  ],
})
class SpecModule {}

const data = (e: SseEvent) => JSON.parse(e.data ?? '{}');
const TERMINAL = ['done', 'not_found', 'error', 'refusal'];

const ESIM_MANUAL = `# Connectivity
## eSIM
The Pixel 10 supports eSIM and dual SIM (one physical nano-SIM plus one eSIM).

## Wi-Fi
Wi-Fi 7, Bluetooth 5.4.

# Battery
A 5000 mAh battery with 45 W wired charging.`;

/**
 * SD-43 against real Postgres (pgvector HNSW + FTS), Redis, ElasticMQ and
 * object storage; hashing embedder + scripted LLM (no network).
 */
describe('Knowledge base & cited answers (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let seeds: SeedsService;
  let db: Sequelize;
  let knowledge: KnowledgeService;
  let retriever: Retriever;
  let llm: ScriptedLlmProvider;
  let config: MockApiConfigService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [SpecModule, AuthApiModule, SeedsModule],
      { stores: ['redis', 'sqs', 'storage'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
    seeds = app.get(SeedsService);
    db = app.get(getConnectionToken());
    knowledge = app.get(KnowledgeService);
    retriever = app.get(Retriever);
    llm = app.get(LLM_PROVIDER);
    config = app.get(ApiConfigService) as MockApiConfigService;
    // Ingestion is driven explicitly (knowledge.ingest) so specs are deterministic; the SQS hop is the worker's job.
    jest.spyOn(app.get(TaskQueue), 'enqueue').mockResolvedValue('m');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    llm.reset();
    config.reset();
  });

  const owner = async () => {
    const created = await app
      .get<typeof User>(getModelToken(User))
      .create({ email: `k-${v4()}@mail.com` });
    const { bearer } = await issueSession(app, created);
    expect(bearer).toMatch(/^Bearer /);
    const shop = await app
      .get<typeof Shop>(getModelToken(Shop))
      .create({ name: 'Phones', slug: `p-${v4().slice(0, 8)}` });
    await app
      .get<typeof ShopMembership>(getModelToken(ShopMembership))
      .create({ shopId: shop.id, userId: created.id, role: 'OWNER' });
    const [product] = await seeds.createTreelike([
      { __type__: TableName.Product, title: 'Pixel 10', shopId: shop.id },
    ]);
    return {
      userId: created.id,
      shopId: shop.id as string,
      productId: product.id as string,
      auth: { Authorization: bearer },
    };
  };

  const indexMarkdown = async (
    o: { shopId: string; userId: string },
    title: string,
    markdown: string,
    extra: { productId?: string; visibility?: 'PUBLIC' | 'SHOP_PRIVATE' } = {},
  ) => {
    const { document } = await knowledge.createMarkdown(
      {
        shopId: o.shopId,
        productId: extra.productId ?? null,
        visibility: extra.visibility ?? 'PUBLIC',
        title,
        createdBy: o.userId,
      },
      markdown,
    );
    await knowledge.ingest(document.id);
    return document.id;
  };

  const ask = (productId: string, question: string) =>
    readSse(`${baseUrl}/products/${productId}/ask`, {
      method: 'POST',
      body: { question },
      count: 1_000,
      until: TERMINAL,
    });

  it('markdown → structure-aware chunks with heading paths, embeddings and FTS', async () => {
    const o = await owner();
    const documentId = await indexMarkdown(o, 'Pixel 10 manual', ESIM_MANUAL, {
      productId: o.productId,
    });

    const chunks = await db.query<{
      headingPath: string;
      tokens: number;
      has_embedding: boolean;
      has_tsv: boolean;
    }>(
      `SELECT "headingPath", tokens, embedding IS NOT NULL AS has_embedding, tsv IS NOT NULL AS has_tsv FROM "KnowledgeChunk" WHERE "documentId" = :documentId ORDER BY ordinal`,
      { type: QueryTypes.SELECT, replacements: { documentId } },
    );
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Pixel 10 manual > Connectivity',
      'Pixel 10 manual > Battery',
    ]);
    expect(chunks.every((c) => c.has_embedding && c.has_tsv)).toBe(true);
    const [doc] = await db.query<{
      status: string;
      chunkCount: number;
      embeddingModel: string;
    }>(`SELECT * FROM "KnowledgeDocument" WHERE id = :documentId`, {
      type: QueryTypes.SELECT,
      replacements: { documentId },
    });
    expect(doc).toMatchObject({
      status: 'READY',
      chunkCount: 2,
      embeddingModel: 'hashing-1024',
    });
  });

  it('PDF: pages and numbered headings survive into chunks (citations can name the page)', async () => {
    const o = await owner();
    const pdf = minimalPdf([
      ['1 Getting started', 'Hold the power button for three seconds.'],
      [
        '2 Connectivity',
        '2.1 eSIM support',
        'The phone supports eSIM and dual SIM.',
      ],
    ]);
    const sha = createHash('sha256').update(pdf).digest('hex');
    const { document, upload } = await knowledge.createPdf(
      {
        shopId: o.shopId,
        productId: o.productId,
        visibility: 'PUBLIC',
        title: 'Pixel PDF',
        createdBy: o.userId,
      },
      sha,
      pdf.length,
    );
    expect(upload?.url).toBeTruthy();
    await app
      .get(ObjectStorage)
      .put(document.storageKey, pdf, 'application/pdf'); // what the client's presigned PUT does
    await knowledge.uploaded(o.shopId, document.id);
    await knowledge.ingest(document.id);

    const found = await retriever.search(
      { kind: 'product', productId: o.productId, shopId: o.shopId },
      'does it support esim',
    );
    expect(found[0]).toMatchObject({
      page: 2,
      headingPath: 'Pixel PDF > 2 Connectivity > 2.1 eSIM support',
    });
  });

  it('a corrupt "PDF" is marked FAILED once (poison), without throwing back to SQS', async () => {
    const o = await owner();
    const junk = Buffer.from('%PDF-1.4 definitely not a pdf');
    const sha = createHash('sha256').update(junk).digest('hex');
    const { document } = await knowledge.createPdf(
      {
        shopId: o.shopId,
        visibility: 'SHOP_PRIVATE',
        title: 'Broken',
        createdBy: o.userId,
      },
      sha,
      junk.length,
    );
    await app
      .get(ObjectStorage)
      .put(document.storageKey, junk, 'application/pdf');
    await knowledge.uploaded(o.shopId, document.id);

    await expect(knowledge.ingest(document.id)).resolves.toBeUndefined();
    expect(await knowledge.get(o.shopId, document.id)).toMatchObject({
      status: 'FAILED',
      error: expect.stringMatching(/PDF could not be parsed/),
    });
  });

  it('content-hash idempotency: the same bytes twice → one document, one indexing; re-delivered ingest is a no-op', async () => {
    const o = await owner();
    const first = await knowledge.createMarkdown(
      {
        shopId: o.shopId,
        productId: o.productId,
        visibility: 'PUBLIC',
        title: 'Manual',
        createdBy: o.userId,
      },
      ESIM_MANUAL,
    );
    const second = await knowledge.createMarkdown(
      {
        shopId: o.shopId,
        productId: o.productId,
        visibility: 'PUBLIC',
        title: 'Manual (again)',
        createdBy: o.userId,
      },
      ESIM_MANUAL,
    );
    expect(second).toMatchObject({
      deduplicated: true,
      document: { id: first.document.id },
    });

    await knowledge.ingest(first.document.id);
    const ids = async () =>
      (
        await db.query<{ id: string }>(
          `SELECT id FROM "KnowledgeChunk" WHERE "documentId" = :id ORDER BY id`,
          { type: QueryTypes.SELECT, replacements: { id: first.document.id } },
        )
      ).map((r) => r.id);
    const before = await ids();
    await knowledge.ingest(first.document.id); // SQS redelivery
    expect(await ids()).toEqual(before);
  });

  it("permissions are inside the query: shop B never retrieves shop A's private documents, even for a perfect match", async () => {
    const [a, b] = [await owner(), await owner()];
    await indexMarkdown(
      a,
      'Supplier contract',
      '# Margins\nOur supplier margin with Acme is 37 percent, renegotiated yearly.',
      { visibility: 'SHOP_PRIVATE' },
    );
    await indexMarkdown(
      b,
      'Returns policy',
      '# Returns\nReturns are accepted within 30 days.',
      { visibility: 'SHOP_PRIVATE' },
    );
    const platformDoc = await knowledge.createMarkdown(
      {
        shopId: null,
        visibility: 'PLATFORM',
        title: 'Seller guide',
        createdBy: a.userId,
      },
      '# Payouts\nPayouts are sent every Monday.',
    );
    await knowledge.ingest(platformDoc.document.id);

    const question = 'what is our supplier margin with Acme';
    const forA = await retriever.search(
      { kind: 'shop', shopId: a.shopId },
      question,
    );
    const forB = await retriever.search(
      { kind: 'shop', shopId: b.shopId },
      question,
    );
    expect(forA.map((c) => c.title)).toContain('Supplier contract');
    expect(forB.map((c) => c.title)).not.toContain('Supplier contract');

    // Both see platform articles; buyers (product scope) see neither shop's private docs nor platform articles.
    expect(
      (
        await retriever.search(
          { kind: 'shop', shopId: b.shopId },
          'when are payouts sent',
        )
      ).map((c) => c.title),
    ).toContain('Seller guide');
    expect(
      await retriever.search(
        { kind: 'product', productId: a.productId, shopId: a.shopId },
        question,
      ),
    ).toEqual([]);
  });

  it('hybrid retrieval: with every vector hit below the similarity floor, FTS alone still finds an exact model number', async () => {
    const o = await owner();
    await indexMarkdown(
      o,
      'Accessories',
      '# Chargers\nCompatible charger: model PX-45W-GAN2 only.',
      { productId: o.productId },
    );
    await indexMarkdown(
      o,
      'Care guide',
      '# Cleaning\nWipe the screen with a dry microfiber cloth.',
      { productId: o.productId },
    );
    config.set('rag_min_similarity', 1.01); // nothing can pass the vector threshold now

    const found = await retriever.search(
      { kind: 'product', productId: o.productId, shopId: o.shopId },
      'PX-45W-GAN2',
    );

    expect(found.map((c) => c.title)).toEqual(['Accessories']);
    expect(found[0].content).toContain('PX-45W-GAN2');
  });

  it('ask this product: streams sources → text → done with citations mapped to the cited chunk', async () => {
    const o = await owner();
    await indexMarkdown(o, 'Pixel 10 manual', ESIM_MANUAL, {
      productId: o.productId,
    });
    llm.script({
      text: 'Yes - it supports eSIM and dual SIM.',
      citations: [0],
    });

    const { status, events } = await ask(
      o.productId,
      'Does the Pixel 10 support eSIM?',
    );

    expect(status).toBe(200);
    expect(events.map((e) => e.event)).toEqual([
      'sources',
      ...events.slice(1, -1).map(() => 'text'),
      'done',
    ]);
    const sources = data(events[0]);
    expect(sources[0]).toMatchObject({
      title: 'Pixel 10 manual',
      headingPath: 'Pixel 10 manual > Connectivity',
    });
    expect(data(events.at(-1)!).citations).toEqual([
      { text: 'Yes - it supports eSIM and dual SIM.', sources: [0] },
    ]);

    // What the model received: the chunks as search_result blocks with citations on, then the question.
    const sent = llm.requests[0].messages[0].content as {
      type: string;
      citations?: { enabled: boolean };
    }[];
    expect(sent.at(-1)).toMatchObject({
      type: 'text',
      text: 'Does the Pixel 10 support eSIM?',
    });
    expect(
      sent
        .slice(0, -1)
        .every((b) => b.type === 'search_result' && b.citations?.enabled),
    ).toBe(true);
    expect(llm.requests[0].tools).toEqual([]);
  });

  it('nothing relevant retrieved → not_found, and the model is never called', async () => {
    const o = await owner();
    await indexMarkdown(o, 'Pixel 10 manual', ESIM_MANUAL, {
      productId: o.productId,
    });

    const { events } = await ask(
      o.productId,
      'zebra migration patterns savanna',
    );

    expect(events.map((e) => e.event)).toEqual(['not_found']);
    expect(llm.requests).toHaveLength(0);
  });

  it('a deleted document disappears from retrieval immediately', async () => {
    const o = await owner();
    const documentId = await indexMarkdown(o, 'Pixel 10 manual', ESIM_MANUAL, {
      productId: o.productId,
    });
    await http()
      .delete(`/api/shops/${o.shopId}/knowledge/documents/${documentId}`)
      .set(o.auth)
      .expect(204);

    expect(
      await retriever.search(
        { kind: 'product', productId: o.productId, shopId: o.shopId },
        'esim',
      ),
    ).toEqual([]);
    const [{ n }] = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM "KnowledgeChunk" WHERE "documentId" = :documentId`,
      { type: QueryTypes.SELECT, replacements: { documentId } },
    );
    expect(Number(n)).toBe(0);
  });

  it("HTTP: only members manage a shop's documents or use its help center; product docs must belong to the shop", async () => {
    const [a, b] = [await owner(), await owner()];
    // Non-members get 404 (ShopGuard: no existence leak); a product of another shop is 403.
    await http()
      .post(`/api/shops/${a.shopId}/knowledge/documents`)
      .set(b.auth)
      .send({ title: 'x', visibility: 'PUBLIC', markdown: '# x\ny' })
      .expect(404);
    await http()
      .post(`/api/shops/${a.shopId}/knowledge/documents`)
      .set(a.auth)
      .send({
        title: 'x',
        visibility: 'PUBLIC',
        productId: b.productId,
        markdown: '# x\ny',
      })
      .expect(403);
    const created = await http()
      .post(`/api/shops/${a.shopId}/knowledge/documents`)
      .set(a.auth)
      .send({
        title: 'FAQ',
        visibility: 'PUBLIC',
        markdown: '# Shipping\nWe ship in 2 days.',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      deduplicated: false,
      document: { status: 'QUEUED' },
    });

    const res = await readSse(`${baseUrl}/shops/${a.shopId}/knowledge/ask`, {
      method: 'POST',
      body: { question: 'shipping time?' },
      headers: b.auth,
      count: 1,
    });
    expect(res.status).toBe(404);
  });
});
