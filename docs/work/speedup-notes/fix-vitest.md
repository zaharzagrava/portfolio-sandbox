# Fixes for failures caused by Vitest running all files in one process

Checked on slice 4 of 5, run on shard 3's names: 1749 tests pass, 6 fail (before: 126 failed in the same slice).
The 6 left are not from this stream: 4 are community suites (100 concurrent requests, a 503 in the burst), sync-feed-consumer (plan limit) and developer-platform-consumers (ClickHouse table per shard). They look like sharding or load problems.

## Causes and fixes
1. resetBreakers is not a function (payments suites, 48 tests). Some spec imports scripts/chat/chat-s24-backfill.ts, which starts with `import 'dotenv/config'`. That copied the developer's backend/.env (PROVIDER_DOUBLES=enabled and more) into the shared process. Every later file then got the scripted payment provider. Under Jest each file had its own process, so it never spread. Fix: test/empty-dotenv-config.ts plus an alias in vitest.e2e.config.ts that turns `dotenv/config` into a no-op. This also fixed the "expected 429, got 200" family in rate-limit, the RedisService-not-found cases (request-context, load-shedding) and similar, because the polluted .env changed their settings.
2. Metrics read 0 (cache, analytics, story-tenancy and others). load-shedding.e2e-spec called MetricsRegistry.reset(), which cuts every counter created when a module was first loaded; later files kept using disconnected counters. Fix: new MetricsRegistry.resetValues() (clears the numbers, keeps the counters) and load-shedding uses it.
3. Trace ids wrong (bff, resilient-http-client). OpenTelemetry keeps its global tracer on globalThis; a file that installed test tracing and shut it down left a dead one for everybody. Fix: libs/infrastructure/events/testing/test-tracing.ts clears the globals before registering and after shutdown.
4. Suites that failed to start. edge-worker.e2e-spec and media-processing.e2e-spec used Jest's `require` of TypeScript files, statements-ops used jest.requireActual with a relative path (resolved from the shim's folder). Fixes: dynamic `await import`, `vi.mock` of the jose file the edge worker really loads (jose lives in packages/edge-be), and createRequire(__filename) in statements-ops.
5. Cache tests through the fault proxy read Redis database 0 instead of the shard's database. Fix: proxyUrl in cache/testing/cache-fixture.module.ts uses the database of REDIS_URL.
6. realtime-publisher used retentionMs 800, below the allowed minimum of 1000 (an earlier speed-up edit). Set to 1000.

## Not changed
Specs still work in Jest apart from the ones above (those now need Vitest: vi.mock/await import).
