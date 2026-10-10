import { Client } from '@elastic/elasticsearch';
import { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsWorkerModule } from '@app/infrastructure/jobs/jobs-worker.module';
import { JobWorker } from '@app/infrastructure/jobs/job-worker.service';
import { Role } from '@app/domains/identity';
import { createTopics, deleteTopicsMatching, testKafka } from '@app/test/utils/kafka-test';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { EMBEDDING_PROVIDER, REINDEX_PROBE } from '../domain/ports';
import type { IndexedDocument } from '../domain/index-document';
import { IndexBootstrapService } from '../infra/index-bootstrap.service';
import { SearchIndexRegistry } from '../infra/search-index-registry';
import { ProductSearchModule } from '../product-search.module';
import { SearchProjectorModule } from '../search-projector.module';
import { SearchWorkerModule } from '../search-worker.module';
import { TestEmbeddingProvider } from './test-embedding.provider';
import { TestReindexProbe } from './reindex-probe';

const ES_NODE = process.env.ELASTICSEARCH_NODE ?? 'http://localhost:9300';

export interface SearchTestApp extends CatalogTestApp {
  /** A client that never goes through the fault proxy: what the specs read the index with. */
  es: Client;
  /** The engine client the application uses (through the proxy when `engineProxy` was asked for). */
  engine: SearchEngineClient;
  /** In front of the engine, when `engineProxy: true`. */
  proxy: TcpFaultProxy | null;
  /** In front of Redis, when `redisProxy: true`. */
  redisProxy: TcpFaultProxy | null;
  embeddings: TestEmbeddingProvider;
  /** Pause points of reindex runs; `reset` between tests. */
  probe: TestReindexProbe;
  /** The job worker, loops off: a spec runs queued jobs with `worker.runOnce()`. */
  worker: JobWorker;
  /** A signed-in administrator. */
  admin(): Promise<Awaited<ReturnType<CatalogTestApp['newUser']>>>;
  /** Recreates `products.events` empty and appends these envelopes to it (the retained history a reindex replays). */
  resetHistory(partitions?: number): Promise<void>;
  publishHistory(events: EventEnvelope[]): Promise<void>;
  sequelize: Sequelize;
  /** Empties the database and rebuilds an empty index behind the live name, like a fresh environment. */
  resetSearch(): Promise<void>;
  /** Makes everything written so far searchable. */
  refresh(): Promise<void>;
  /** The stored document, by a real-time get on the live index. */
  doc(productId: string): Promise<IndexedDocument | null>;
  /** Number of documents of the live index matching the query (refreshed first). */
  count(query?: object): Promise<number>;
  /** All concrete products indices with the aliases they carry. */
  indices(): Promise<Record<string, string[]>>;
  rows<T extends object>(sql: string, bind?: unknown[]): Promise<T[]>;
}

/**
 * The real app the search specs run against: the catalog test app (identity, tenancy, rate limit, outbox, jobs) plus
 * the search projector and worker modules over the real engine, Postgres, Redis and ClickHouse of the test stack.
 * Faked only at the system edges: the embedding provider (deterministic phrases, a gate and a failure switch) and,
 * on request, a TCP fault proxy in front of the engine.
 */
export async function createSearchApp(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    engineProxy?: boolean;
    /** A fault proxy in front of Redis (the rate limiter's store), to prove the limiter fails open. */
    redisProxy?: boolean;
    env?: Record<string, string>;
  } = {},
): Promise<SearchTestApp> {
  const embeddings = new TestEmbeddingProvider();
  const probe = new TestReindexProbe();
  const proxy = options.engineProxy
    ? await TcpFaultProxy.start({ host: 'localhost', port: new URL(ES_NODE).port ? Number(new URL(ES_NODE).port) : 9300 })
    : null;
  const redisProxy = options.redisProxy
    ? await TcpFaultProxy.start({ host: 'localhost', port: 6400 })
    : null;
  const base = await createCatalogApp({
    ...(redisProxy ? { redisUrl: `redis://127.0.0.1:${redisProxy.port}/0` } : {}),
    prependImports: [ProductSearchModule],
    extraImports: [
      JobsModule,
      JobsWorkerModule.register({ loops: false }),
      SearchProjectorModule,
      SearchWorkerModule,
      ...(options.extraImports ?? []),
    ],
    overrides: [
      { provide: EMBEDDING_PROVIDER, useValue: embeddings },
      { provide: REINDEX_PROBE, useValue: probe },
      ...(options.overrides ?? []),
    ],
    env: {
      // short windows keep the specs fast; production defaults are 1 s and 30 s
      SEARCH_REGISTRY_TTL_MS: '100',
      SEARCH_REINDEX_VERIFY_WAIT_MS: '1500',
      ...(proxy ? { ELASTICSEARCH_NODE: `http://127.0.0.1:${proxy.port}` } : {}),
      ...options.env,
    },
  });
  const es = new Client({ node: ES_NODE });
  const sequelize = base.app.get(Sequelize);
  const engine = base.app.get(SearchEngineClient, { strict: false });

  const app: SearchTestApp = {
    ...base,
    es,
    engine,
    proxy,
    redisProxy,
    embeddings,
    probe,
    worker: base.app.get(JobWorker, { strict: false }),
    admin: () => base.newUser({ role: Role.ADMIN }),
    async resetHistory(partitions = 3) {
      await deleteTopicsMatching(/^products\.events$/);
      await createTopics([{ topic: 'products.events', numPartitions: partitions }]);
    },
    async publishHistory(events) {
      const producer = testKafka().producer();
      await producer.connect();
      for (let i = 0; i < events.length; i += 500)
        await producer.send({
          topic: 'products.events',
          messages: events.slice(i, i + 500).map((e) => ({
            key: e.aggregateId,
            value: JSON.stringify(e),
          })),
        });
      await producer.disconnect();
    },
    sequelize,
    async resetSearch() {
      for (const p of [proxy, redisProxy])
        if (p) {
          p.mode = 'pass';
          p.delayMs = 0;
        }
      embeddings.reset();
      probe.reset();
      await base.reset();
      // the engine refuses wildcard deletes: name every products index (and a legacy concrete one) explicitly
      const names = Object.keys(
        await es.indices
          .get({
            index: 'products*',
            expand_wildcards: 'all',
            ignore_unavailable: true,
          })
          .catch(() => ({})),
      );
      if (names.length > 0)
        await es.indices.delete({ index: names, ignore_unavailable: true });
      base.app.get(SearchIndexRegistry, { strict: false }).invalidate();
      await base.app.get(IndexBootstrapService, { strict: false }).ensureLiveIndex();
      base.app.get(SearchIndexRegistry, { strict: false }).invalidate();
    },
    async refresh() {
      await es.indices.refresh({ index: 'products*', ignore_unavailable: true });
    },
    async doc(productId) {
      const res = await es
        .get({ index: 'products', id: productId })
        .catch((e: { statusCode?: number }) =>
          e.statusCode === 404 ? null : Promise.reject(e),
        );
      return res ? (res._source as IndexedDocument) : null;
    },
    async count(query) {
      await app.refresh();
      const res = await es.count({ index: 'products', ...(query && { query }) });
      return res.count;
    },
    async indices() {
      const res = await es.indices.get({ index: 'products*', expand_wildcards: 'all' });
      return Object.fromEntries(
        Object.entries(res).map(([name, info]) => [name, Object.keys(info.aliases ?? {})]),
      );
    },
    rows: <T extends object>(sql: string, bind: unknown[] = []) =>
      sequelize.query<T>(sql, { type: QueryTypes.SELECT, bind }),
    async close() {
      await base.close();
      await es.close();
      await proxy?.close();
      await redisProxy?.close();
    },
  };
  return app;
}
