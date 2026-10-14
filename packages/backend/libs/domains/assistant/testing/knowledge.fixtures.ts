import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ApiConfigService } from '@app/common/config';
import type { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { Role } from '@app/domains/identity';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import {
  readSse,
  type SseEvent,
  type SseResult,
} from '@app/test/utils/sse-client';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import {
  createProduct,
  type ProductSeed,
  type SeededProduct,
} from '@app/test/utils/catalog-fixtures';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { IngestService } from '../application/ingest.service';
import {
  CALL_RECORDER,
  EMBEDDING_PROVIDER,
  EmbeddingUnavailableError,
  TASK_PUBLISHER,
} from '../domain/ports';
import type {
  CallRecord,
  CallRecorder,
  EmbedOptions,
  EmbeddingProvider,
  TaskPublisher,
} from '../domain/ports';
import { CallRecorderAdapter } from '../infra/call-recorder.adapter';
import { HashingEmbedder } from '../infra/embedder';
import { LLM_PROVIDER } from '../infra/llm/llm-provider';
import { ScriptedLlmProvider } from '../infra/llm/scripted.provider';
import {
  MODERATION_BACKEND,
  type ModerationBackend,
} from '../infra/moderator.adapter';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import {
  KnowledgeModule,
  KnowledgeProjectorModule,
  KnowledgeWorkerModule,
} from '../knowledge.module';

/** An embedder that can be told to fail, stall, or answer slowly; it records every call it receives. */
export class ControllableEmbedder implements EmbeddingProvider {
  readonly dimensions = 1024;
  readonly testOnly = true;
  readonly calls: { texts: string[]; kind: EmbedOptions['kind'] }[] = [];
  /** Fail the next `n` calls with a transient error (`Infinity` = always). */
  failures = 0;
  /** Never answer (until aborted). */
  stalled = false;
  /**
   * Stand-in for what a real model knows: texts are rewritten before hashing, so "virtual SIM" and "eSIM" share a
   * feature (a paraphrase found by meaning, never by words). Applies to documents and questions alike.
   */
  synonyms: [string, string][] = [['virtual sim', 'esim']];
  private readonly inner = new HashingEmbedder();

  constructor(public model = 'hashing-1024') {}

  reset(): void {
    this.calls.length = 0;
    this.failures = 0;
    this.stalled = false;
    this.model = 'hashing-1024';
  }

  async embed(texts: string[], options: EmbedOptions): Promise<number[][]> {
    this.calls.push({ texts, kind: options.kind });
    if (this.stalled)
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener('abort', () =>
          reject(new EmbeddingUnavailableError('aborted')),
        );
      });
    if (this.failures > 0) {
      this.failures--;
      throw new EmbeddingUnavailableError('injected failure');
    }
    return this.inner.embed(
      texts.map((text) =>
        this.synonyms.reduce(
          (t, [from, to]) => t.replace(new RegExp(from, 'gi'), to),
          text,
        ),
      ),
    );
  }

  /** Calls made for questions (not documents). */
  get queryCalls() {
    return this.calls.filter((c) => c.kind === 'query');
  }
  get documentCalls() {
    return this.calls.filter((c) => c.kind === 'document');
  }
}

/** Records the ingestion tasks the services publish instead of sending them; can refuse. */
export class RecordingPublisher implements TaskPublisher {
  readonly published: string[] = [];
  failNext = 0;

  reset(): void {
    this.published.length = 0;
    this.failNext = 0;
  }

  enqueueIngest(documentId: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('queue down'));
    }
    this.published.push(documentId);
    return Promise.resolve();
  }

  count(documentId: string): number {
    return this.published.filter((id) => id === documentId).length;
  }
}

/** Records every call the answer service would send to the usage ledger. */
export class RecordingRecorder implements CallRecorder {
  readonly records: CallRecord[] = [];
  /** Also publish through the real adapter (Kafka). */
  delegate: CallRecorder | null = null;
  useDelegate = false;

  reset(): void {
    this.records.length = 0;
    this.useDelegate = false;
  }

  async record(call: CallRecord): Promise<void> {
    this.records.push(call);
    if (this.useDelegate && this.delegate) await this.delegate.record(call);
  }
}

/** Moderation backend stub: flag by substring, delay, or fail. */
export class ModerationStub implements ModerationBackend {
  /** Flag any text containing one of these (case-insensitive) with the given category. */
  flags: { contains: string; category: string }[] = [];
  delayMs = 0;
  fail = false;
  readonly seen: { text: string; context: string | null }[] = [];

  reset(): void {
    this.flags = [];
    this.delayMs = 0;
    this.fail = false;
    this.seen.length = 0;
  }

  async classify(
    text: string,
    context: string | null,
  ): ReturnType<ModerationBackend['classify']> {
    this.seen.push({ text, context });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new Error('moderation backend down');
    const hay = `${context ?? ''}${text}`.toLowerCase();
    const hit = this.flags.find((f) => hay.includes(f.contains.toLowerCase()));
    return hit ? { flagged: true, category: hit.category } : { flagged: false };
  }
}

export interface Seller {
  owner: TestUser;
  shopId: string;
  product: SeededProduct;
}

export interface KnowledgeTestApp extends CatalogTestApp {
  config: MockApiConfigService;
  db: Sequelize;
  baseUrl: string;
  embedder: ControllableEmbedder;
  tasks: RecordingPublisher;
  recorder: RecordingRecorder;
  moderation: ModerationStub;
  llm: ScriptedLlmProvider;
  /** A TCP proxy in front of Redis (only with `redisProxy: true`): `mode = 'refuse'` takes the limiter store down. */
  redisProxy: TcpFaultProxy | null;
  /** Captured stdout of the structured logger (only with `structuredLogger: true`). */
  rawLogs(): string;
  logs(): Array<Record<string, any>>;
  /** A shop with an owner and one active product. */
  seller(options?: {
    shopStatus?: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED';
    product?: ProductSeed;
  }): Promise<Seller>;
  /** Another product of the shop. */
  product(shopId: string, seed?: ProductSeed): Promise<SeededProduct>;
  /** A member of the shop with the given role. */
  member(shopId: string, role: 'ADMIN' | 'STAFF' | 'VIEWER'): Promise<TestUser>;
  admin(): Promise<TestUser>;
  /** `POST /api/shops/:id/knowledge/documents` as `user`. */
  create(
    user: TestUser,
    shopId: string,
    body: Record<string, unknown>,
  ): ReturnType<ReturnType<CatalogTestApp['as']>['post']>;
  /** Creates a markdown document through the API (201 or 200) and returns its id. */
  markdown(
    seller: Seller,
    title: string,
    markdown: string,
    extra?: {
      productId?: string | null;
      visibility?: 'PUBLIC' | 'SHOP_PRIVATE';
    },
  ): Promise<string>;
  /** Creates a markdown document through the API and runs one ingestion pass, like the worker would. */
  index(
    seller: Seller,
    title: string,
    markdown: string,
    extra?: {
      productId?: string | null;
      visibility?: 'PUBLIC' | 'SHOP_PRIVATE';
    },
  ): Promise<string>;
  /** A platform article through the admin API, ingested. */
  platformArticle(
    admin: TestUser,
    title: string,
    markdown: string,
  ): Promise<string>;
  /** One ingestion pass (the queue handler) for a document. */
  ingest(documentId: string, receiveCount?: number): Promise<void>;
  document(documentId: string): Promise<Record<string, any> | undefined>;
  chunks(documentId: string): Promise<Record<string, any>[]>;
  /** Ask a product (anonymous when `user` is null) and read the whole stream. */
  askProduct(
    productId: string,
    question: unknown,
    user?: TestUser | null,
    raw?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<SseResult>;
  askShop(
    shopId: string,
    question: unknown,
    user: TestUser | null,
    raw?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<SseResult>;
  /** Counter or gauge value of a metric series (0 when it has not moved). */
  metric(
    name: string,
    labels?: Record<string, string | number | boolean>,
  ): number;
}

export const TERMINAL = ['done', 'not_found', 'error', 'refusal'];
export const data = (e: SseEvent) => JSON.parse(e.data ?? '{}');
export const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export const ESIM_MANUAL = `# Connectivity
## eSIM
The Pixel 10 supports eSIM and dual SIM (one physical nano-SIM plus one eSIM).

## Wi-Fi
Wi-Fi 7, Bluetooth 5.4.

# Battery
A 5000 mAh battery with 45 W wired charging.`;

/**
 * The app the knowledge specs run against: the real catalog + tenancy + identity pipeline (`createCatalogApp`), the
 * real `KnowledgeModule` and `KnowledgeWorkerModule`, real Postgres (pgvector), Redis, ElasticMQ and object storage.
 * Only the system edges are replaced: the embedding provider (deterministic hashing, can fail or stall), the model
 * (the scripted provider), the moderation backend (a stub), and the two ports whose effect is observed rather than
 * performed (the ingestion task publisher, the usage recorder). Ingestion is driven explicitly through the queue
 * handler (`ingest`), so specs are deterministic.
 */
export async function createKnowledgeApp(
  options: {
    env?: Record<string, string>;
    redisProxy?: boolean;
    /** Run the real deletion consumers (S53 runner) against the shared `products.events` / `tenancy.events` topics. */
    consumers?: boolean;
    /** Run the production JSON logger and capture its stdout lines (`rawLogs()`, `logs()`). */
    structuredLogger?: boolean;
  } = {},
): Promise<KnowledgeTestApp> {
  const logChunks: string[] = [];
  const stdoutSpy = options.structuredLogger
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logChunks.push(String(chunk));
          return true;
        })
    : null;
  const embedder = new ControllableEmbedder();
  const tasks = new RecordingPublisher();
  const recorder = new RecordingRecorder();
  const moderation = new ModerationStub();
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start({ host: 'localhost', port: 6400 })
    : null;

  const base = await createCatalogApp({
    extraImports: [
      KnowledgeModule,
      KnowledgeWorkerModule,
      ...(options.consumers
        ? [
            KnowledgeProjectorModule,
            ProjectionsModule.forProjectors(
              KnowledgeProjectorModule.projectors,
              [KnowledgeProjectorModule],
            ),
          ]
        : []),
    ],
    env: options.env,
    structuredLogger: options.structuredLogger,
    ...(redisProxy && { redisUrl: `redis://127.0.0.1:${redisProxy.port}/0` }),
    customize: (builder) =>
      builder
        .overrideProvider(EMBEDDING_PROVIDER)
        .useValue(embedder)
        .overrideProvider(TASK_PUBLISHER)
        .useValue(tasks)
        .overrideProvider(CALL_RECORDER)
        .useValue(recorder)
        .overrideProvider(MODERATION_BACKEND)
        .useValue(moderation),
  });
  const { app } = base;
  const config = app.get(ApiConfigService) as MockApiConfigService;
  const db = app.get(Sequelize);
  const llm = app.get<ScriptedLlmProvider>(LLM_PROVIDER);
  const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
  recorder.delegate = app.get(CallRecorderAdapter);

  const t: KnowledgeTestApp = {
    ...base,
    config,
    db,
    baseUrl,
    embedder,
    tasks,
    recorder,
    moderation,
    llm,
    redisProxy,
    rawLogs: () => logChunks.join(''),
    logs: () =>
      logChunks
        .join('')
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, any>),
    async close() {
      stdoutSpy?.mockRestore();
      await base.close();
      await redisProxy?.close();
    },
    async reset() {
      if (redisProxy) redisProxy.mode = 'pass';
      await base.reset();
      embedder.reset();
      tasks.reset();
      recorder.reset();
      moderation.reset();
      llm.reset();
      config.reset();
      await db.query(`DELETE FROM "KnowledgeChunk"`);
      await db.query(`DELETE FROM "KnowledgeDocument"`);
      // Question embeddings are derived data and survive between runs: start each test without them.
      const redis = app.get(RedisService).client;
      // Rate-limit buckets of the two ask policies live a minute: a spec that exhausts one must not leak into the next.
      for (const pattern of [
        'rag:qe:v1:*',
        'rl:{rag.ask|*',
        'rl:{llm.provider.tpm|*',
        'rl:{rag.ingest|*',
      ]) {
        const keys = await redis.keys(pattern);
        if (keys.length) await redis.del(...keys);
      }
    },
    async seller(opts = {}) {
      const owner = await base.newUser();
      const shop = await createShop(app, owner, { status: opts.shopStatus });
      const product = await createProduct(app, { id: shop.id }, opts.product);
      return { owner, shopId: shop.id as string, product };
    },
    product: (shopId, seed = {}) => createProduct(app, { id: shopId }, seed),
    async member(shopId, role) {
      const user = await base.newUser();
      await addMember(app, shopId, user.id, role);
      return user;
    },
    admin: () => base.newUser({ role: Role.ADMIN }),
    create: (user, shopId, body) =>
      base.as(user).post(`/api/shops/${shopId}/knowledge/documents`).send(body),
    async markdown(seller, title, markdown, extra = {}) {
      const res = await t.create(seller.owner, seller.shopId, {
        title,
        visibility: extra.visibility ?? 'PUBLIC',
        ...(extra.productId ? { productId: extra.productId } : {}),
        markdown,
      });
      if (![200, 201].includes(res.status))
        throw new Error(
          `create document: ${res.status} ${JSON.stringify(res.body)}`,
        );
      return res.body.document.id as string;
    },
    async index(seller, title, markdown, extra) {
      const id = await t.markdown(seller, title, markdown, extra);
      await t.ingest(id);
      return id;
    },
    async platformArticle(admin, title, markdown) {
      const res = await base
        .as(admin)
        .post('/api/admin/knowledge/documents')
        .send({ title, markdown });
      if (![200, 201].includes(res.status))
        throw new Error(
          `create article: ${res.status} ${JSON.stringify(res.body)}`,
        );
      await t.ingest(res.body.document.id);
      return res.body.document.id as string;
    },
    ingest: (documentId, receiveCount = 1) =>
      app.get(IngestService).ingest(documentId, receiveCount),
    async document(documentId) {
      const [row] = await db.query<Record<string, any>>(
        `SELECT * FROM "KnowledgeDocument" WHERE id = :documentId`,
        { type: QueryTypes.SELECT, replacements: { documentId } },
      );
      return row;
    },
    chunks: (documentId) =>
      db.query<Record<string, any>>(
        `SELECT id, "documentId", "shopId", "productId", visibility, ordinal, "headingPath", page, content, tokens, "embeddingModel",
                embedding IS NOT NULL AS has_embedding, tsv IS NOT NULL AS has_tsv
           FROM "KnowledgeChunk" WHERE "documentId" = :documentId ORDER BY ordinal`,
        { type: QueryTypes.SELECT, replacements: { documentId } },
      ),
    askProduct: (productId, question, user = null, raw = {}) =>
      readSse(`${baseUrl}/products/${productId}/ask`, {
        method: 'POST',
        body: 'body' in raw ? raw.body : { question },
        headers: {
          ...(user ? { Authorization: user.bearer } : {}),
          ...raw.headers,
        },
        count: 1_000,
        until: TERMINAL,
        timeoutMs: 20_000,
      }),
    askShop: (shopId, question, user, raw = {}) =>
      readSse(`${baseUrl}/shops/${shopId}/knowledge/ask`, {
        method: 'POST',
        body: 'body' in raw ? raw.body : { question },
        headers: {
          ...(user ? { Authorization: user.bearer } : {}),
          ...raw.headers,
        },
        count: 1_000,
        until: TERMINAL,
        timeoutMs: 20_000,
      }),
    metric: (name, labels = {}) => MetricsRegistry.value(name, labels) ?? 0,
  };
  return t;
}
