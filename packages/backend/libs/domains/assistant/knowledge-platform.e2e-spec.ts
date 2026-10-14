import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import { ConfigRules } from '@app/common/config/config-rules';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { installTestTracing } from '@app/infrastructure/events/testing/test-tracing';
import { ownedBy, ownerOf } from '../../../db/ownership';
import { AskService } from './application/ask.service';
import { SweepService } from './application/sweep.service';
import {
  normalizeQuestion,
  questionCacheKey,
} from './application/knowledge-search.service';
import { ANSWER_MODEL, EMBEDDING_PROVIDER } from './domain/ports';
import { HashingEmbedder, VoyageEmbedder } from './infra/embedder';
import { KnowledgeConfigGuard } from './infra/knowledge-config.guard';
import {
  createKnowledgeApp,
  ESIM_MANUAL,
  type KnowledgeTestApp,
} from './testing/knowledge.fixtures';

const hex = () => uuidv7().replace(/-/g, '').slice(-12);

/** The ask stream as the service sees it, without HTTP: records the event names. */
class CollectingSink {
  closed = false;
  events: string[] = [];
  begin(): void {}
  send(event: string): void {
    this.events.push(event);
  }
  end(): void {}
  onClose(): void {}
}

describe('RAG: configuration, observability, boundaries', () => {
  let t: KnowledgeTestApp;

  beforeAll(async () => {
    t = await createKnowledgeApp({ structuredLogger: true });
  }, 180_000);
  afterAll(() => t.close());
  beforeEach(() => t.reset());

  describe('S47 AS-53: observability without private text', () => {
    const RAG_METRICS = [
      'rag_ingest_total',
      'rag_ingest_duration_seconds',
      'rag_retrieval_duration_seconds',
      'rag_retrieval_degraded_total',
      'rag_retrieval_deadline_total',
      'rag_answers_total',
      'rag_documents',
      'rag_cache_errors_total',
      'rag_moderation_rejected_total',
    ];

    it('S47 AS-53: the metrics move with ingestion, retrieval and answers', async () => {
      const s = await t.seller();
      const cam = await t.newUser();
      const ingested = t.metric('rag_ingest_total', { outcome: 'ready' });
      const ingestTimings =
        MetricsRegistry.histogramValue('rag_ingest_duration_seconds', {
          outcome: 'ready',
        })?.count ?? 0;
      const answered = t.metric('rag_answers_total', { outcome: 'answered' });
      const notFound = t.metric('rag_answers_total', { outcome: 'not_found' });
      const refused = t.metric('rag_answers_total', { outcome: 'refused' });
      const failed = t.metric('rag_answers_total', { outcome: 'error' });
      const hybrid =
        MetricsRegistry.histogramValue('rag_retrieval_duration_seconds', {
          mode: 'hybrid',
        })?.count ?? 0;
      const keyword =
        MetricsRegistry.histogramValue('rag_retrieval_duration_seconds', {
          mode: 'keyword',
        })?.count ?? 0;
      const degraded = t.metric('rag_retrieval_degraded_total', {
        reason: 'embed_failed',
      });

      await t.index(s, 'Pixel 10 manual', ESIM_MANUAL, {
        productId: s.product.id,
      });
      t.llm.script(
        { text: 'Yes - it supports eSIM.', citations: [0] },
        { stopReason: 'refusal', text: '' },
        { unavailable: true },
        { text: 'Yes - it supports eSIM.', citations: [0] },
      );
      await t.askProduct(s.product.id, 'Does the Pixel 10 support eSIM?', cam);
      await t.askProduct(
        s.product.id,
        'Does the Pixel 10 support eSIM and dual SIM?',
        cam,
      );
      await t.askProduct(
        s.product.id,
        'Does the Pixel 10 support eSIM and Wi-Fi?',
        cam,
      );
      await t.askProduct(s.product.id, 'zebra migration patterns savanna', cam);
      t.embedder.failures = Infinity;
      await t.askProduct(
        s.product.id,
        'Is eSIM supported by the Pixel 10 at all?',
        cam,
      );
      await t.app.get(SweepService).run();

      expect(t.metric('rag_ingest_total', { outcome: 'ready' })).toBe(
        ingested + 1,
      );
      expect(
        MetricsRegistry.histogramValue('rag_ingest_duration_seconds', {
          outcome: 'ready',
        })!.count,
      ).toBe(ingestTimings + 1);
      expect(t.metric('rag_answers_total', { outcome: 'answered' })).toBe(
        answered + 2,
      );
      expect(t.metric('rag_answers_total', { outcome: 'refused' })).toBe(
        refused + 1,
      );
      expect(t.metric('rag_answers_total', { outcome: 'error' })).toBe(
        failed + 1,
      );
      expect(t.metric('rag_answers_total', { outcome: 'not_found' })).toBe(
        notFound + 1,
      );
      expect(
        MetricsRegistry.histogramValue('rag_retrieval_duration_seconds', {
          mode: 'hybrid',
        })!.count,
      ).toBeGreaterThan(hybrid);
      expect(
        MetricsRegistry.histogramValue('rag_retrieval_duration_seconds', {
          mode: 'keyword',
        })!.count,
      ).toBe(keyword + 1);
      expect(
        t.metric('rag_retrieval_degraded_total', { reason: 'embed_failed' }),
      ).toBe(degraded + 1);
      expect(t.metric('rag_documents', { status: 'READY' })).toBe(1);
    });

    it('S47 AS-53: no log line, metric label or trace attribute holds a question, a document text or title, a presigned address or a secret; the question hash is the cache hash', async () => {
      const tokens = {
        title: `ttl${hex()}`,
        body: `bdy${hex()}`,
        question: `qst${hex()}`,
      };
      const s = await t.seller();
      const cam = await t.newUser();
      const admin = await t.admin();
      const markdown = `# Notes\nThe widget ${tokens.question} ${tokens.body} ships in blue within three days.`;
      const question = `does the widget ${tokens.question} ship in blue`;
      const tracing = installTestTracing();
      let spans: ReturnType<typeof tracing.exporter.getFinishedSpans> = [];
      try {
        // ingestion, including a PDF create (a presigned address is returned to the caller, never logged)
        const id = await t.index(s, tokens.title, markdown, {
          productId: s.product.id,
        });
        await t.create(s.owner, s.shopId, {
          title: `${tokens.title} pdf`,
          visibility: 'PUBLIC',
          pdfSha256: 'b'.repeat(64),
          pdfSize: 1234,
        });
        await t.platformArticle(
          admin,
          `${tokens.title} article`,
          `# A\nplatform ${tokens.body}`,
        );

        // every outcome of a question
        t.llm.script(
          { text: `The widget ships ${tokens.body}.`, citations: [0] },
          { unavailable: true },
        );
        await t.askProduct(s.product.id, question, cam);
        await t.askProduct(s.product.id, `blue ${question}`, cam); // provider down
        t.embedder.failures = Infinity;
        await t.askProduct(s.product.id, `${question} blue`, cam); // degraded to keywords
        t.embedder.failures = 0;
        t.moderation.flags = [{ contains: 'forbidden', category: 'violence' }];
        await t.askProduct(s.product.id, `${question} forbidden`, cam); // rejected before retrieval
        t.moderation.flags = [];
        await t.askProduct(
          s.product.id,
          `${tokens.question} unrelated words about zebras`,
          cam,
        ); // not found
        await t.askProduct(uuidv7(), question, cam); // unknown product

        // a question asked inside a span: the span carries the hash and counts, nothing of the text
        const sink = new CollectingSink();
        t.llm.script({ text: `Blue ${tokens.body}.`, citations: [0] });
        await tracing.tracer.startActiveSpan(
          'rag-ask-under-test',
          async (span) => {
            await t.app
              .get(AskService)
              .ask(
                cam.id,
                { kind: 'product', productId: s.product.id },
                question,
                sink,
              );
            span.end();
          },
        );
        expect(sink.events.at(-1)).toBe('done');
        spans = tracing.exporter.getFinishedSpans();

        await t
          .as(s.owner)
          .delete(`/api/shops/${s.shopId}/knowledge/documents/${id}`)
          .expect(204);
        await t
          .as(s.owner)
          .get(`/api/shops/${s.shopId}/knowledge/documents`)
          .expect(200);
      } finally {
        await tracing.shutdown();
      }

      // 1. logs: nothing private, a hash prefix for questions, a request id on every request-scoped line
      const raw = t.rawLogs();
      for (const secret of [
        tokens.title,
        tokens.body,
        tokens.question,
        'X-Amz-Signature',
        'X-Amz-Credential',
        cam.bearer.replace('Bearer ', ''),
        s.owner.bearer.replace('Bearer ', ''),
      ])
        expect(raw).not.toContain(secret);
      const lines = t
        .logs()
        .filter((l) =>
          String(l.msg ?? l.message ?? '').startsWith('rag question'),
        );
      expect(lines.length).toBeGreaterThanOrEqual(6);
      const hashes = lines.map(
        (l) => /question=([0-9a-f]{12})/.exec(String(l.msg ?? l.message))![1],
      );
      const key = questionCacheKey('hashing-1024', normalizeQuestion(question));
      expect(hashes).toContain(
        key.slice('rag:qe:v1:'.length, 'rag:qe:v1:'.length + 12),
      );
      for (const line of lines.slice(0, -1))
        expect(
          line.requestId ?? line.req?.id ?? line.reqId ?? line['x-request-id'],
        ).toBeTruthy();

      // 2. metric labels: bounded outcomes only
      const labels = RAG_METRICS.flatMap((name) =>
        MetricsRegistry.labelSets(name),
      )
        .map((l) => JSON.stringify(l))
        .join(' ');
      for (const secret of [
        tokens.title,
        tokens.body,
        tokens.question,
        s.shopId,
        s.product.id,
        cam.id,
      ])
        expect(labels).not.toContain(secret);

      // 3. spans: the one span of the question carries the same hash prefix, the outcome and counts
      const span = spans.find((x) => x.name === 'rag-ask-under-test')!;
      expect(span.attributes).toMatchObject({
        'rag.outcome': 'answered',
        'rag.mode': 'hybrid',
        'rag.question_hash': key.slice(
          'rag:qe:v1:'.length,
          'rag:qe:v1:'.length + 12,
        ),
      });
      const attributes = spans
        .map((x) =>
          JSON.stringify([x.name, x.attributes, x.events.map((e) => e.name)]),
        )
        .join(' ');
      for (const secret of [tokens.title, tokens.body, tokens.question])
        expect(attributes).not.toContain(secret);
    }, 120_000);
  });

  describe('S47 AS-54: startup configuration', () => {
    const guard = async (
      config: Record<string, unknown>,
      embedder: object,
      model: { scripted: boolean } | null,
    ) => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          KnowledgeConfigGuard,
          {
            provide: ApiConfigService,
            useValue: { get: (k: string) => config[k] },
          },
          { provide: EMBEDDING_PROVIDER, useValue: embedder },
          ...(model ? [{ provide: ANSWER_MODEL, useValue: model }] : []),
        ],
      }).compile();
      return moduleRef.init();
    };
    const real = new VoyageEmbedder('pa-key-value', 'voyage-3.5', 128);

    it('S47 AS-54: production refuses the deterministic test embedder, naming the key and no value', async () => {
      await expect(
        guard({ node_env: 'production' }, new HashingEmbedder(), {
          scripted: false,
        }),
      ).rejects.toThrow(/voyage_api_key/);
    });

    it('S47 AS-54: production refuses the scripted model provider', async () => {
      await expect(
        guard({ node_env: 'production' }, real, { scripted: true }),
      ).rejects.toThrow(/anthropic_api_key/);
    });

    it('S47 AS-54: production refuses an embedding model whose dimension is not 1,024', async () => {
      const small = {
        model: 'x',
        dimensions: 512,
        testOnly: false,
        embed: async () => [],
      };
      await expect(
        guard({ node_env: 'production' }, small, { scripted: false }),
      ).rejects.toThrow(/voyage_model/);
    });

    it('S47 AS-54: every violation is reported together and no value is printed', async () => {
      const small = {
        model: 'x',
        dimensions: 512,
        testOnly: true,
        embed: async () => [],
      };
      const error = await guard(
        { node_env: 'production', voyage_api_key: 'pa-secret-value' },
        small,
        { scripted: true },
      ).catch((e: Error) => e);
      expect((error as Error).message).toMatch(
        /voyage_api_key.*voyage_model.*anthropic_api_key/,
      );
      expect((error as Error).message).not.toContain('pa-secret-value');
    });

    it('S47 AS-54: production with the real embedder and a real provider starts; development allows the test embedder', async () => {
      await expect(
        guard({ node_env: 'production' }, real, { scripted: false }),
      ).resolves.toBeDefined();
      await expect(
        guard({ node_env: 'development' }, new HashingEmbedder(), {
          scripted: true,
        }),
      ).resolves.toBeDefined();
      await expect(
        guard({ node_env: 'test' }, new HashingEmbedder(), null),
      ).resolves.toBeDefined();
    });

    it('S47 AS-54: the configuration rules refuse a production start without the embedding key, the moderation backend and the cursor key', () => {
      const violations = ConfigRules.validate(
        { voyage_api_key: '', knowledge_cursor_key: 'short' },
        { production: true },
      );
      const ours = violations.filter((v) => v.startsWith('[knowledge]'));
      expect(ours.join(' ')).toMatch(/voyage_api_key/);
      expect(ours.join(' ')).toMatch(/moderation_backend/);
      expect(ours.join(' ')).toMatch(/knowledge_cursor_key/);
      expect(ours.join(' ')).not.toContain('short');
      expect(
        ConfigRules.validate({}, { production: false }).filter((v) =>
          v.startsWith('[knowledge]'),
        ),
      ).toEqual([]);
    });
  });

  describe('S47 AS-55: domain boundaries', () => {
    it('S47 AS-55: neither table has a foreign key to another domain’s table', async () => {
      const keys = await t.db.query<{ from: string; to: string }>(
        `SELECT c.conrelid::regclass::text AS "from", c.confrelid::regclass::text AS "to"
           FROM pg_constraint c
          WHERE c.contype = 'f' AND (c.conrelid::regclass::text IN ('"KnowledgeDocument"', '"KnowledgeChunk"'))`,
        { type: QueryTypes.SELECT },
      );
      expect(keys.map((k) => `${k.from}->${k.to}`)).toEqual([
        '"KnowledgeChunk"->"KnowledgeDocument"',
      ]);
      const inbound = await t.db.query<{ from: string }>(
        `SELECT c.conrelid::regclass::text AS "from" FROM pg_constraint c
          WHERE c.contype = 'f' AND c.confrelid::regclass::text IN ('"KnowledgeDocument"', '"KnowledgeChunk"')`,
        { type: QueryTypes.SELECT },
      );
      expect(inbound.map((k) => k.from)).toEqual(['"KnowledgeChunk"']); // nothing outside the domain points at them
    });

    it('S47 AS-55: the ownership registry lists both tables under the assistant domain', () => {
      expect(ownerOf('KnowledgeDocument')).toBe('domain:assistant');
      expect(ownerOf('KnowledgeChunk')).toBe('domain:assistant');
      expect(ownedBy('domain:assistant')).toEqual(
        expect.arrayContaining(['KnowledgeDocument', 'KnowledgeChunk']),
      );
    });
  });
});
