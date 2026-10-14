# Quickstart: validating S42 — Seller public API

Run from `packages/backend` unless noted. Spec runner: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed result plus the full-log path; open the log only when that is not enough). Narrowest file first; the whole capability once at the end, in batches of fresh processes (L-008: a batch without its summary line is a crash, not a flaky test).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`): Postgres with the real migrations (including the S42 expand and FK-drop migrations), Redis, ClickHouse with `api_requests` and its additive columns, Kafka and ElasticMQ stand-ins. Compare tables, keyspaces and queues with the doctor (L-011, L-002): queue `public-api-bulk-chunk` and its DLQ in `elasticmq.conf`.
- Config: `api_key_pepper` set in the test environment (the boot-failure test unsets it on purpose, AS-21).
- The e2e kit freezes and advances the injected clock (`2026-10-06T12:00:00Z`); faults use switchable wrappers at the system edge (Redis fast store, event producer, limiter store, quota port, queue) and are restored in `afterEach` (L-013).

## Scenario runs (each file is one `describe`, see [`test-plan.md`](test-plan.md))

| Step | Command | Expected |
|---|---|---|
| 1 pure rules | `pnpm run test libs/domains/developer-platform/domain` | `api-key-format`, `key-status`, `versioning`, `deprecation`, `sparse-fields`, `bulk-chunking`, `usage-bucket` specs green (with `fast-check` properties) |
| 2 keys | `test-spec.sh libs/domains/developer-platform/api-keys.e2e-spec.ts` | AS-01…AS-11 (AS-05, AS-07, AS-09 repeat 20×) |
| 3 auth | `test-spec.sh libs/domains/developer-platform/public-api-auth.e2e-spec.ts` | AS-13…AS-19, AS-21 |
| 4 sandbox | `test-spec.sh libs/domains/developer-platform/public-api-sandbox.e2e-spec.ts` | AS-22…AS-25 |
| 5 versions | `test-spec.sh libs/domains/developer-platform/public-api-versions.e2e-spec.ts` | AS-26…AS-34 |
| 6 resources | `test-spec.sh libs/domains/developer-platform/public-api-resources.e2e-spec.ts` | AS-37…AS-42 |
| 7 batch and bulk | `test-spec.sh libs/domains/developer-platform/public-api-batch.e2e-spec.ts` | AS-43…AS-47, AS-49…AS-52 |
| 8 limits | `test-spec.sh libs/domains/developer-platform/public-api-limits.e2e-spec.ts` | AS-48, AS-53…AS-57 |
| 9 logs and usage | `test-spec.sh libs/domains/developer-platform/public-api-logs-usage.e2e-spec.ts` | AS-35, AS-58…AS-61, AS-63 |
| 10 consumers | `test-spec.sh libs/domains/developer-platform/developer-platform-consumers.e2e-spec.ts` | AS-12, AS-62, AS-64 (duplicate and invalid payload for each) |
| 11 contract | `test-spec.sh libs/domains/developer-platform/public-api-contract.e2e-spec.ts` | AS-36, AS-65…AS-69, AS-71 |
| 12 sibling regressions | `test-spec.sh libs/domains/orders/order-read` ; `test-spec.sh libs/domains/catalog/` (batches) ; `test-spec.sh libs/infrastructure/idempotency` ; `test-spec.sh libs/domains/developer-platform/webhooks.e2e-spec.ts libs/domains/developer-platform/widget.e2e-spec.ts` | green (additive `getShopOrder`, additive idempotency options, webhook/widget untouched) |
| 13 static gates | `pnpm tsc --noEmit -p .`, `pnpm lint`, from repo root `pnpm check:boundaries`, `pnpm check:module-graph`, `pnpm check:model-registry`, then `pnpm --dir packages/backend check:table-ownership --strict` | clean; S42 lines 0 (`.ownership.baseline` 10 → webhook/widget lines only), `.tx.baseline` stays 0 |
| 14 leftovers | `grep -rn "sequelize.transaction\|S54 T037 audit" libs/domains/developer-platform` ; `grep -rnE "FROM \"(Product|Shop|ShopOrder|BisOrder|BisOrderItem)\"" libs/domains/developer-platform` | both empty for S42 files |
| 15 living spec | `python3 scripts/livespec/check.py` (repo root) | passes with the new `S42` page (every `[proof: …]` and `[code: …]` true) |
| 16 contracts | `pnpm run test libs/domains/developer-platform/public-api-contract.e2e-spec.ts` (parses each sample body with each supported version's schema) | every sample parses; error-code enum equals `contracts/http.md` |

The old `public-api.e2e-spec.ts` is deleted only after each of its six scenarios is listed with its new file (L-017; mapping in `tasks.md`).

## Start the real apps (L-004, L-015, L-018, L-019)

`apps/public-api`, `apps/core`, `apps/worker` and `apps/projector` are each started alone by wiring specs (`apps/<app>/src/public-api-wiring.e2e-spec.ts`, `apps/core/src/developers-wiring.e2e-spec.ts`; run with `test-spec.sh apps/public-api/src apps/core/src/developers-wiring apps/worker/src/public-api-wiring apps/projector/src/public-api-wiring`): public-api maps all `/v1` routes (a mapped route answers `401` problem+json without a key, an unmapped one `404`), refuses to start without `api_key_pepper`, and declares both rate policies; core maps the dashboard routes and `GET /api/developers/openapi.json`; worker registers the three `public-api.*` jobs and the `public-api-bulk-chunk` consumer; projector registers `public-api-request-log`, `public-api-usage-metering` and `public-api-shop-lifecycle`. These are automated, so they have no row in `specs/UNVERIFIED.md`. Starting the built binaries (`scripts/infra/boot-app.sh public-api|core|worker|projector`) is a runtime proof done at the final checkpoint with scripts (L-019).

## Operator notes

- Bulk jobs in flight during deploy lived in Redis (`bulkstock:<id>`, 24 h TTL): they answer `404` after the change. Clients re-submit with the same operation IDs (S05 makes that safe).
- Set `api_key_pepper` before deploying; the previous value (`api_key_pepper_previous`) is only needed when rotating it.

## Ops artifacts (criteria no automated test proves)

| Criterion | How to run it | Status |
|---|---|---|
| SC-010: 30,000 requests per second across 100,000 keys, 99 % of authenticated reads under 150 ms, per-key limits across instances, logging and metering add no latency | `scripts/load-tests/public-api-mixed.test.js` (k6, new) against 3+ `public-api` instances | not run |
| SC-009 retention half: request records exist for 30 days and are gone after (tests prove search and the TTL declaration, not 30 real days) | read the `api_requests` table TTL in ClickHouse and sample a 29-day-old record in a long-lived environment | not run |
| Quota against the real billing store (S18 `checkQuota` is not exported yet; the adapter allows and counts `public_api_quota_degraded_total{reason="not_available"}`; AS-57 is proven with a fake port) | after S18 ships: set a tiny plan quota for a test shop, exceed it, expect `429 quota_exceeded` | not run |
| SC-001 and SC-007 at higher counts than the tests (20 and 200 concurrent) | loop AS-09 and AS-54 with `REPEAT=1000` | not run |
| Built-binary start of `public-api`, `core`, `worker`, `projector` and the empty-stack run (L-012, L-019) | `scripts/infra/boot-app.sh <app>`, `scripts/qa/fresh-run.sh`, then steps 2–11 | not run |
| W04 UI journey (`packages/web/e2e/developers.spec.ts`: create, reveal once, rotate, revoke, pin) | Playwright once W04 ships the screens; the API halves are AS-01, AS-06, AS-08, AS-30 | not run |

## Implementation notes

**L-017 mapping of the deleted `public-api.e2e-spec.ts`** (scenarios, not files; each target is green before the file was deleted):

| Old test | Scenario now proved by |
|---|---|
| tenant comes from the key; a revoked key stops at once | `public-api-auth.e2e-spec.ts` AS-16 (foreign product, stock and order are 404), AS-13 (every bad key is the one 401), `api-keys.e2e-spec.ts` AS-08, AS-09 |
| scopes are enforced per endpoint | `public-api-auth.e2e-spec.ts` AS-15 (every route × scope) |
| date versions: latest by default, older by header or by pin | `public-api-versions.e2e-spec.ts` AS-26…AS-30 |
| deprecated routes announce Deprecation, Sunset and the successor | `public-api-versions.e2e-spec.ts` AS-32…AS-34 |
| Idempotency-Key: retries replay, reuse with another body is refused | `public-api-limits.e2e-spec.ts` AS-53, AS-54 |
| test keys act on an isolated sandbox shop | `public-api-sandbox.e2e-spec.ts` AS-22…AS-25 |
| bulk stock and stable cursor pagination | `public-api-batch.e2e-spec.ts` AS-50…AS-52, `public-api-resources.e2e-spec.ts` AS-37 |

**Where the work landed that is not obvious from `plan.md`**

- The request context (`Request-Id`, `no-store`, deprecation headers, and the one record per authenticated call) is mounted *before* the body parsers with `configureHttpApp({ beforeBodyParsing: [publicApiRequestContext(app)] })`, so a request the parser refuses still has its identifiers and its record. Every deployable that hosts `PublicApiModule` must pass it (`apps/public-api/src/main.ts` does; the kit does).
- `configureHttpApp({ cors: false })` is how `apps/public-api` grants no origin.
- Three additive options in `libs/infrastructure/idempotency` (`scope`, `wire`, with `storeClientErrors`) and one column widening (`IdempotencyKey.key` to 255) serve the public contract; existing routes are unchanged.
- ClickHouse for the test stack: `node --env-file=.env.test -r ts-node/register -r tsconfig-paths/register scripts/clickhouse/migrate.ts`; Postgres: `pnpm run db:jest:migrate:up`.
