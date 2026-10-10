import { v4 } from 'uuid';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import {
  suggestResponseSchema,
  type SuggestResponse,
} from '@marketplace-sandbox/contracts';
import { AutocompleteModule } from '../autocomplete.module';
import { AutocompleteWorkerModule } from '../autocomplete-worker.module';
import { AutocompleteBuildService } from '../application/autocomplete-build.service';
import { QueryIndexService } from '../application/query-index.service';
import { AUTOCOMPLETE_POINTER } from '../infra/snapshot-pointer.adapter';
import { createSearchApp, type SearchTestApp } from './search-app';

export interface AutocompleteTestApp extends SearchTestApp {
  clickhouse: ClickHouseService;
  storage: ObjectStorage;
  redis: RedisService;
  build: AutocompleteBuildService;
  index: QueryIndexService;
  /** Empties the log table, the snapshot objects and the pointer (this app's in-memory index is not touched). */
  resetAutocomplete(): Promise<void>;
  /** `searchers` distinct people searched `query` (and got `results` results). */
  logQuery(
    query: string,
    searchers: number,
    options?: { results?: number; surface?: string; at?: Date },
  ): Promise<void>;
  /** Builds a snapshot from the log and loads it on this node; returns the build outcome. */
  publish(): Promise<Awaited<ReturnType<AutocompleteBuildService['build']>>>;
  /** `GET /api/suggest`, parsed with the response schema. */
  suggest(q: string, params?: Record<string, string>): Promise<SuggestResponse>;
  snapshotVersions(): Promise<string[]>;
  pointer(): Promise<string | null>;
}

const extraNodes: AutocompleteTestApp[] = [];

/**
 * Another serving node of the same stores (a restart, a second replica). Closing one app closes the process-wide
 * database pool, so extra nodes stay up for the rest of the file and `closeNodes` shuts everything down at the end.
 */
export async function startNode(
  options: Parameters<typeof createSearchApp>[0] = {},
): Promise<AutocompleteTestApp> {
  const node = await createAutocompleteApp(options);
  extraNodes.push(node);
  return node;
}

export async function closeNodes(main: AutocompleteTestApp): Promise<void> {
  for (const node of extraNodes.splice(0))
    await node.app.close().catch(() => undefined);
  await main.close().catch(() => undefined);
}

export async function createAutocompleteApp(
  options: Parameters<typeof createSearchApp>[0] = {},
): Promise<AutocompleteTestApp> {
  const base = await createSearchApp({
    ...options,
    extraImports: [
      AutocompleteModule,
      AutocompleteWorkerModule,
      ...(options.extraImports ?? []),
    ],
  });
  const clickhouse = base.app.get(ClickHouseService, { strict: false });
  const storage = base.app.get(ObjectStorage, { strict: false });
  const redis = base.app.get(RedisService, { strict: false });
  await applyClickHouseDdl(
    clickhouse,
    '030_search_queries.sql',
    '110_search_measurement.sql',
  );

  const t: AutocompleteTestApp = {
    ...base,
    clickhouse,
    storage,
    redis,
    build: base.app.get(AutocompleteBuildService, { strict: false }),
    index: base.app.get(QueryIndexService, { strict: false }),
    async resetAutocomplete() {
      await clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE search_queries' });
      for (const o of await storage.list('autocomplete/'))
        await storage.delete(o.key);
      await redis.client.del(AUTOCOMPLETE_POINTER);
    },
    async logQuery(query, searchers, o = {}) {
      const ts = (o.at ?? new Date()).toISOString().replace('Z', '');
      await clickhouse.getClient().insert({
        table: 'search_queries',
        format: 'JSONEachRow',
        values: Array.from({ length: searchers }, () => ({
          event_id: v4(),
          query,
          results: o.results ?? 10,
          user_hash: v4().slice(0, 16),
          ts,
          ...(o.surface ? { surface: o.surface } : {}),
        })),
      });
    },
    async publish() {
      const outcome = await t.build.build();
      await t.index.refresh();
      return outcome;
    },
    async suggest(q, params = {}) {
      const res = await base
        .http()
        .get('/api/suggest')
        .query({ q, ...params })
        .expect(200);
      return suggestResponseSchema.parse(res.body);
    },
    async snapshotVersions() {
      return (await storage.list('autocomplete/')).map((o) => o.key).sort();
    },
    pointer: () => redis.client.get(AUTOCOMPLETE_POINTER),
  };
  return t;
}
