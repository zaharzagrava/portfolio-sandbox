# Fix: per-shard setup of the stores

## What was wrong
1. ClickHouse: `shard-prepare.sh` only created an empty database `marketplace_test_s<n>` and said "the specs create their tables". Most do not (api_requests, search_queries and others come from `packages/backend/clickhouse/*.sql`). Result: "Unknown table api_requests" and "Table marketplace_test_s3.search_queries does not exist".
2. `safe-request.e2e-spec.ts` (36 tests, "getaddrinfo ENOTFOUND undefined"): not a missing variable and not the shard at all. The spec has `beforeEach(() => resolver.mockClear())`. `mockClear` hands back the mock itself, and Vitest treats a function returned from a hook as a clean-up and calls it (with no arguments, so the host is `undefined`), which throws. Jest ignored the return value. Fixed by giving the hook a body with braces. The test checks are unchanged.
3. Scylla fulfilment specs ('location_history_unavailable', 'ping: 503'): the keyspace was fine (tables exist in `marketplace_s2`). The one test that expects that 503 passes; the other failures in that group were not caused by missing tables (most likely Kafka topic creation, see below).

## Changes
- `scripts/infra/shard-prepare.sh`: ClickHouse step now runs `scripts/clickhouse/migrate.ts` with the shard's database (same way as the Scylla step). Header comment updated.
- `packages/backend/libs/infrastructure/net/safe-request.e2e-spec.ts`: hook written with a body.

## Not mine / still to watch
- "KafkaJSAggregateError: Topic creation errors" (146 tests) is the biggest group; it was not part of this stream.
- Other specs have `afterEach(() => spy.mockRestore())` style hooks that also return a function to Vitest (cache-read-path, workers-wiring, csp-reports, knowledge-ask, feed-read, webhook-delivery). They did not show the same error but are the same trap.
