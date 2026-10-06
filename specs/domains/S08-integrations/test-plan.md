# Test Plan: S08 — Shopify/WooCommerce Catalog and Stock Sync (domain `catalog-sync`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (80 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/catalog-sync/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `IntegrationsModule`, `IntegrationsWorkerModule` and `IntegrationsProjectorModule` (and the tenancy, identity and **catalog** modules they depend on, the outbox, the rate limiter, the scheduler, the task queue and the idempotent consumer framework) with the production pipe, filter, prefix, raw-body capture and interceptors, through `supertest`, against real Postgres, Redis, Kafka and SQS stand-ins from `docker-compose.test.yaml` with real migrations. Every test asserts the response body **and** the persisted state (links, cursors, runs, quarantine, conflicts, receipts, outbox rows, queue messages, and the products through the catalog's exported query). The queue handlers are invoked through the real consumers.
- Only system-edge dependencies are faked: the providers are **fake HTTP servers speaking the real Shopify Admin REST and WooCommerce REST v3 shapes** (`test/fakes/fake-shopify.ts`, `test/fakes/fake-woocommerce.ts`) with injectable page size, `updatedAt` semantics (a write bumps `updatedAt`, like the real thing), conditional stock writes, `429` with `Retry-After`, `401`, slow and dropped connections, malformed items and an observable request log; DNS resolution (a stub resolver for the SSRF cases); the clock (frozen and advanced). Faults use real mechanisms: a Postgres trigger raising on an insert into `ExternalLink` or on an update of the product table's guard, a gated page (the test releases it to freeze a worker at a chosen page), a killed lease (the test moves the clock past it), a Redis stop for the limiter, a queue stub that fails once. Mocking or stubbing the project's own repositories, ORM or stores is forbidden.
- Consumers (the sync queues, `products.events`, `tenancy.shop_offboarding_started`, `tenancy.shop_offboarding_cancelled`, `tenancy.shop_deleted`) each have the duplicate-delivery and invalid-payload tests of VII.4 (AS-25, AS-40, AS-74, AS-75; the webhook route's duplicate rule is AS-28).
- Unit specs sit beside the code under `domain/` (adapter parsing under `infra/`), are table-driven (`it.each`), and exist only for pure logic (VII.5): provider-to-normalised mapping, money parsing (with `fast-check`), the stock merge (with `fast-check`), webhook signature and timestamp rules, address classification for the SSRF guard, the integration status machine, watermark arithmetic, retry classification and backoff bounds, the breaker state machine, reconciliation classification and the mass-deletion rule. No unit tests for controllers, repositories, consumers or glue.
- UI journey (Playwright, owned by W04, happy path only): `packages/web/tests/seller-integrations.spec.ts` — a seller admin chooses "Connect Shopify", completes the (fake) provider's approval, lands back on the integrations page with the connection `ACTIVE`, and after the sync the imported products are listed. No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-80).
- Contract layer (VII.6): every e2e parses responses with the schema named in the spec (`integrationInstallResponseSchema`, `integrationSchema`, `integrationPageSchema`, `quarantineItemSchema`, `quarantinePageSchema`, `stockConflictSchema`, `conflictPageSchema`, `reconciliationReportSchema`, `reconciliationPageSchema`) and outbox payloads with `integrationEventSchemas`.
- Gate 9 (VII.9): AS-31, AS-43, AS-55 (limiter down), AS-56, AS-58, AS-59 and AS-63 are degradation or fallback paths and each forces its fault.
- The existing `integrations.e2e-spec.ts` is replaced by the files below (its five tests map to AS-47, AS-16, AS-36, AS-26 and AS-62).

Abbreviations for the e2e files (all under `libs/domains/catalog-sync/`):

| Key | File | Top-level `describe` |
|---|---|---|
| C | `integration-connect.e2e-spec.ts` | `Integration connect and OAuth` |
| Y | `integration-sync.e2e-spec.ts` | `Integration incremental sync` |
| W | `integration-webhooks.e2e-spec.ts` | `Integration webhooks` |
| K | `integration-stock.e2e-spec.ts` | `Integration bidirectional stock` |
| Q | `integration-quarantine.e2e-spec.ts` | `Integration quarantine` |
| R | `integration-resilience.e2e-spec.ts` | `Integration provider resilience` |
| N | `integration-reconcile.e2e-spec.ts` | `Integration reconciliation` |
| M | `integration-manage.e2e-spec.ts` | `Integration management API` |
| L | `integration-lifecycle.e2e-spec.ts` | `Integration lifecycle and events` |
| B | `integration-boundary.e2e-spec.ts` | `Catalog-sync integrations module boundary` |

Unit files (all under `libs/domains/catalog-sync/domain/` unless noted): `normalise.spec.ts` (provider mapping, stock quirks), `money.spec.ts`, `stock-merge.spec.ts`, `webhook-verify.spec.ts`, `store-address.spec.ts`, `integration-status.spec.ts`, `watermark.spec.ts`, `retry-policy.spec.ts`, `breaker.spec.ts`, `reconcile-classify.spec.ts`.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 install start | C: member gets `authorizeUrl` (host, path, client id, scopes, redirect, `state` entropy), install record with digest only and 10-minute expiry | — | — |
| AS-02 install validation | C: table-driven over every bad `shopDomain` and body, nothing persisted; viewer `403`, no credentials `401` | — | — |
| AS-03 callback success | C: valid HMAC and state → token exchange, `302`, integration `ACTIVE`, sealed credentials, 4 webhook subscriptions at the fake, history, one `integration_connected` row, one backfill message, install consumed | `seller-integrations.spec.ts`: connect Shopify → back on the integrations page `ACTIVE` → products listed | — |
| AS-04 callback rejections | C: each failure class (hmac, altered param, old timestamp, unknown/expired/used state, wrong shop, missing param) → identical `400`, no exchange call, nothing stored; exchange refused → `302 ?error=oauth_exchange_failed` | — | — |
| AS-05 callback replay and race | C: `Promise.all` of two valid callbacks plus a later one → one `302`, others `400`; one integration, one event, one message | — | — |
| AS-06 WooCommerce connect | C: verify call, currency, webhook registration with generated secret, `201`, no secret in body; keys rejected `422`; timeout/5xx `503` generic, nothing stored; repeat post `200` same id | — | — |
| AS-07 store URL guard | C: stub resolver → private / metadata / loopback targets refused with no outbound call; public-then-private rebinding refused at call time and on later sync calls; redirect refused | — | `store-address.spec.ts`: table-driven classification of IPv4/IPv6, literals, ports, schemes, user-info |
| AS-08 currency | C: EUR store vs USD platform → `422 currency_mismatch` (Woo) and `302 ?error=currency_mismatch` (Shopify), nothing created | — | — |
| AS-09 reconnect | C: `NEEDS_REAUTH` and `DISCONNECTED` integrations reconnected → same id, new credentials, cursor reset, one backfill, links kept, no duplicates after backfill | — | — |
| AS-10 one connection per store | C: store held by shop A → shop B refused; `Promise.all` of two shops on a free store → one integration | — | — |
| AS-11 integration limit | C: sixth refused `409`; `Promise.all` of two connects at 4 → count never above 5 | — | — |
| AS-12 backfill | Y: page size 2, 7 variants + 1 draft → catalog calls ≤ 500 items, 7 products with provider stock, 7 links with ids/skus/digest/raw, watermark = max fetched, run record, backfill queue only, no provider write | — | — |
| AS-13 idempotent replay | Y: second backfill → `unchanged: 7`, no catalog row or event, no duplicates | — | — |
| AS-14 normalisation | — | — | `normalise.spec.ts`: Shopify and WooCommerce fixtures → normalised item or rejection code (multi-variant titles, HTML strip, category default, tags, long title, missing title, draft, no inventory item, long external id, digest over provider-owned fields only) |
| AS-15 money parsing | — | — | `money.spec.ts`: `it.each` over the stated strings and exponents; `fast-check`: parse(format(n)) = n, no float in the path |
| AS-16 incremental with overlap | Y: provider asked since exactly `W − 5 min`; old item not requested; changed `updated`, near-boundary `unchanged`; second run applies nothing | — | `watermark.spec.ts`: overlap arithmetic, max-fetched advance, clamp to now, never backwards (table-driven) |
| AS-17 checkpoints, resume | Y: worker killed after page 3 → resume at page 4 (request log), counters add up, watermark moves only at the end; future-dated item clamped | — | — |
| AS-18 single runner | Y: `Promise.all` of two messages → one run, one `skipped_locked`; clock past lease → stale holder's checkpoint refused, watermark never regresses | — | — |
| AS-19 run budget yields | Y: 12 pages, budget 3 → `yielded`, one continuation message, continuation finishes; time budget by clock | — | — |
| AS-20 scheduled pull | Y: mixed integrations → exactly 3 messages, jittered next-due times in the window; second run enqueues none | — | — |
| AS-21 backfill vs incremental queues | Y: backfill of A gated mid-run, incremental of B completes meanwhile; queue names and concurrencies asserted | — | — |
| AS-22 out-of-order snapshot | Y: older `updatedAt` applied after newer → `stale`, no change, no catalog call | — | — |
| AS-23 concurrent apply | Y: `Promise.all` of webhook-fetch and page → one `updated`, one `unchanged`, version +1, one event | — | — |
| AS-24 crash between catalog and link write | Y: trigger fails the link write once → retry completes, one product, one link, stock not doubled | — | — |
| AS-25 queue messages | Y: duplicate `one` and `incremental` deliveries change nothing; invalid payload classes rejected/DLQ'd without effect; unknown/disconnected integration acked | — | — |
| AS-26 valid webhook | W: correct HMAC → `200` before any provider call, receipt, one message; worker then fetches current state and applies; no credentials needed | — | — |
| AS-27 forged or malformed | W: wrong/absent/re-serialised/foreign-secret signatures and non-JSON → identical `401`; unknown, malformed, disconnected ids identical `401`; nothing enqueued or recorded | — | `webhook-verify.spec.ts`: Shopify and WooCommerce base64 HMAC over bytes, constant-time compare, length mismatch |
| AS-28 duplicate delivery | W: same id twice and `Promise.all` twice → all `200`, one message, one receipt | — | — |
| AS-29 stale timestamp | W: 5 min accepted, 5 min 1 s and older `401 webhook_stale`; no timestamp (Woo) accepted | — | `webhook-verify.spec.ts`: boundary table at 299/300/301 s and skew |
| AS-30 delete and uninstall | W: `products/delete` confirmed by `404` → link `DELETED_AT_PROVIDER`, stock zeroed by one command; item still present → untouched; `app/uninstalled` → `DISCONNECTED`, credentials erased, no more provider calls | — | — |
| AS-31 enqueue failure | W: queue stub fails → `503`, no receipt; redelivery after recovery → `200`, one message | — | — |
| AS-32 limits | W: 1 MiB+1 → `413`; 1,201st request/minute and 601st per address → `429` with `Retry-After`; limiter store down → webhook still accepted | — | — |
| AS-33 WooCommerce webhook | W: base64 signature, delivery id dedupe; ping body → `200` nothing enqueued; wrong signature `401` | — | — |
| AS-34 paused integration | W: `PAUSED` and `NEEDS_REAUTH` → `200`, nothing enqueued or recorded | — | — |
| AS-35 inbound stock merge | K: base 10, provider 7 → one `-3` command with deterministic operation id, local 7, `syncedStock` 7, no provider write | — | — |
| AS-36 outbound push, echo ignored | K: local sale via S05's stock command → one conditional write `set 8 expected 10`; echo pull applies nothing and pushes nothing; also a stock change made by the S09-style writer path | — | — |
| AS-37 both sides sold | K: table-driven over both processing orders → 5 on both sides, precondition refusal abandoned without overwrite, one accepted write, no conflict | — | — |
| AS-38 oversold conflict | K: base 3, local 0, remote 1 → both 0, one `OPEN` conflict with numbers, one event, re-run opens none | — | — |
| AS-39 conflict routes | K: list with cursor and tamper, dismiss `200`, dismiss again `409`, other shop `404`, stock unchanged | — | — |
| AS-40 product-event consumer | K: unlinked, sandbox, no-quantity, inactive integration → no write; duplicate eventId and older version → single/none; own-apply event → none; invalid payloads dead-lettered; other shop's event cannot reach the link | — | — |
| AS-41 stale read | K: page fetched before our write completed (gated) applied after → stock ignored, fields applied, no double count | — | — |
| AS-42 crash replay | K: crash after the catalog applied the delta → replay `replayed: true`, local changed once; later genuine 10→7 has another op id and applies | — | — |
| AS-43 push failure | K: 503 ×3 → run ends failed, `syncedStock` unchanged; recovery → provider equals local; `404` → link `DELETED_AT_PROVIDER` | — | — |
| AS-44 coalescing | K: three events in one batch → one `set 7 expected 10` | — | — |
| AS-45 merge rule | — | — | `stock-merge.spec.ts`: `it.each` over the stated tuples; `fast-check`: result in `[0, 1e9]`, equals `L + R − B` in range, symmetric in `L`/`R`, deterministic |
| AS-46 local deletion | K: `catalog.product_deleted` then provider changes → link `IGNORED`, no resurrection, no push; repeat no-op | — | — |
| AS-47 quarantine, sync continues | Q: 4 good + `price: "free"` → counters, `completed_with_quarantine`, watermark past it, one row with code and payload, metric moved, logs free of the payload | — | — |
| AS-48 no duplicate rows | Q: 12 re-reads → one row, `occurrences: 13`; changed bad payload updates in place; id-less item deduped by digest | — | — |
| AS-49 auto-resolution | Q: fixed at provider → applied, row `RESOLVED` `fixed_at_provider` | — | — |
| AS-50 review routes | Q: list/filter/cursor, retry (resolved and still invalid), dismiss, `409` on non-open, `404` cross-tenant, concurrent dismiss/retry one winner | — | — |
| AS-51 catalog refusal | Q: catalog `rejected` for one of 5 → 4 applied, one `catalog_rejected` with field and code | — | — |
| AS-52 stock quirks | — | — | `normalise.spec.ts`: negative → 0, out of range, non-integer, untracked, missing level (table-driven) |
| AS-53 mass drift halts | Q: 1,001 malformed → stops at 1,000, `halted_schema_drift`, watermark unchanged, one attention event, next pull +1 h, good items kept | — | — |
| AS-54 response validation | R: invalid envelope (non-array, HTML 200, wrong type) → `failed provider_schema_invalid`, nothing stored; foreign-host / wrong-scheme `Link` not followed | — | — |
| AS-55 shared rate budget | R: two worker instances, 12 calls, bucket 5/s → never more than 5 per window, no 429, other credential unaffected; Redis stopped → `yielded`, zero provider calls | — | — |
| AS-56 `Retry-After` | R: `429` + 3 s → bucket paused for all workers, one retry after ≥ 3 s, no other call meanwhile; above 60 s → `yielded`, continuation with that delay | — | — |
| AS-57 retry policy | R: 503, 503, 200 → success on attempt 3; non-retryable statuses once; stock write retried on timeout; webhook registration not retried; at most 3 attempts | — | `retry-policy.spec.ts`: status/verb → retryable table, full-jitter bounds, attempt cap |
| AS-58 timeouts | R: silent provider → aborted at 15 s, failure counted, retried, run `failed` retryable, message back on queue, lease released | — | — |
| AS-59 circuit breaker | R: 5 failures → open for 5 min, runs `skipped_breaker_open`, scheduler skips, one attention event; after 5 min exactly one probe; success closes, failure reopens without a second event | — | `breaker.spec.ts`: closed/open/half-open transitions table |
| AS-60 auth failure and refresh | R: 401 with refresh token → one refresh, retry succeeds; `Promise.all` of two workers → one refresh call; no token or refresh refused → `NEEDS_REAUTH`, history, one status and one attention event, scheduler skips | — | — |
| AS-61 classification | N: seeded drift → exact counts, fixes (queued pull, normal inbound path, push 4), batch local read, report stored | — | `reconcile-classify.spec.ts`: classification and the "exactly one side differs" rule (table-driven) |
| AS-62 deletion check | N: absent from listing → direct read `404` confirms → link state, one zeroing command, product not archived, rerun no-op; still present → `list_inconsistent`; relisted → `ACTIVE`, stock merged from 0 | — | — |
| AS-63 mass-deletion guard | N: 3 of 100 listed → nothing changed, `aborted_mass_delete`, one attention event; listing fails midway → `failed`, nothing deleted | — | `reconcile-classify.spec.ts`: guard thresholds (9 vs 10 links, 20% vs 21%) |
| AS-64 immutable reports | N: direct update of a finished run refused by the store; next run lists `previousRunId` outcomes; first report byte-identical | — | — |
| AS-65 report routes | N: list with cursor, detail with truncation flag, on-demand `202`, second within the hour `429`, paused `409`, cross-tenant `404` | — | — |
| AS-66 lag alert | N: lag over 30 min → one event; repeat none; recovery then recurrence → one new event; gauge value | — | — |
| AS-67 list and detail | M: 7 integrations, `limit=3` pages, order and cursor, bad limits and tampered cursor `400`, detail body parsed, no secret anywhere | — | — |
| AS-68 state machine | M: pause/resume results per state, `409` illegal moves with no event, resume enqueues incremental + reconcile, concurrent pause/resume one history row | — | `integration-status.spec.ts`: transition table over every state × action, `assertNever` |
| AS-69 disconnect | M: `204`, credentials erased, deregistration attempted once and its failure tolerated, links kept, in-flight run stops, queued message no-op, second `DELETE` `204` without event | — | — |
| AS-70 sync now | M: `202 enqueued` true/false, `429` within a minute, backfill resets cursor and limited hourly, illegal states `409`, breaker open reason, bad mode `400` | — | — |
| AS-71 permissions and tenant isolation | M: role × route matrix (`OWNER`/`ADMIN` `2xx`, `STAFF`/`VIEWER` `403`), other-shop member `404`, no credentials `401`, cross-shop IDs identical `404`, suspended/deleting gate | — | — |
| AS-72 validation and errors | M: unknown/missing/mistyped fields, non-UUID ids, malformed queries → `400` with `errors`; problem+json shape and `requestId` on every error; 5xx detail generic | — | — |
| AS-73 shop not active | L: tenancy says not `ACTIVE` → `skipped_shop_not_active`, no provider call, no failure counted; suspension between start and write → run ends skipped, resumes from checkpoint later | — | — |
| AS-74 offboarding | L: event → `ACTIVE` integrations `PAUSED(shop_offboarding)`, seller-paused untouched; cancel → only own pauses resume with catch-up; duplicate delivery one effect; invalid payload dead-lettered | — | — |
| AS-75 shop deleted | L: all data of the shop purged in batches ≤ 1,000, credentials gone, other shops untouched, products untouched; redelivery no-op; invalid payload dead-lettered | — | — |
| AS-76 retention | L: records of every age → exact deletions per kind, ≤ 5,000 per kind per run, open items older than 90 days closed `expired`, second run deletes nothing | — | — |
| AS-77 events | L: each lifecycle change writes exactly one outbox row in its transaction with the envelope and a schema-valid payload; none on `409`, replay or no-op | — | — |
| AS-78 observability | L: structured logs carry ids; metrics exist and move as listed; scan of logs, labels, spans, bodies, outbox for tokens/secrets/payloads finds none | — | — |
| AS-79 secrets | L: database scan finds no plaintext; ciphertext swapped between integrations fails to open → `NEEDS_REAUTH`, no provider call, event; key rotation keeps working; erased on disconnect and purge | — | — |
| AS-80 module boundary | B: `check:table-ownership --strict` clean for this domain's files, spy over the catalog's services sees every product write, trigger on the product table raises for this domain's writes, barrel exports exactly the three modules, production wiring has no fake provider | — | — |
