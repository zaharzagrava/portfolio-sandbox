# Test Plan: S05 — Products (domain `catalog`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/catalog/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `ProductModule` (plus `ProductBatchReadModule`, `ProductWorkerModule`, `ProductProjectorModule` where the file needs them, the tenancy and identity modules they depend on, the outbox, the rate limiter and the cache) with the production pipe, filter, prefix and interceptors, against real Postgres (migrated), Redis and Kafka/SQS stand-ins from `docker-compose.test.yaml`. Time is frozen with the shared clock helper (it moves the application clock; Redis keeps its own), state is reset in `beforeEach`, seeding goes through the shared fixture helpers (`createUser`, `createShop(owner)`, `addMember`, `createProduct(shop, overrides)`), and every test asserts the response **and** the persisted state (rows, cache keys, outbox rows, delivered messages).
- Only system-edge dependencies are faked. Redis, Postgres and the event stream are real. **Fault injection** uses real mechanisms: a TCP fault proxy in front of Redis (`test/fakes/tcp-fault-proxy.ts`: refuse, hang, delay), a Postgres trigger created by the test that raises on `INSERT` into the outbox table or `UPDATE` of the product table, an `ACCESS EXCLUSIVE` lock held by a second connection, and `pg_stat_statements`-style statement counting through a Sequelize logging hook on the real connection (counts are observation, never a stub). The slow-reader race of AS-43 drives the real cache service with a gated loader. Two application instances (`appA`, `appB`) are booted in one test process where a scenario needs two instances.
- Consumers (`catalog.product_*`, `tenancy.shop_status_changed`, `tenancy.shop_deleted`) are driven by delivering real envelopes to the real consumer entry point; each has the duplicate-delivery and invalid-payload tests of VII.4 (AS-41, AS-44, AS-77, AS-78).
- R1 services (`ProductQueryService`, `ProductStockService`, `ProductImportService`, `ProductCommandService`) are exercised from a test module that imports only `@app/domains/catalog` (the public entry point), which also proves the exports are sufficient (AS-86).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): status machine, stock delta rule (with `fast-check`), input normalisation. No unit tests for controllers, repositories, consumers or glue.
- UI journeys (Playwright, owned by W04 and W02, happy path only): `packages/web/tests/seller.spec.ts` (inventory: add a product, edit price and stock, archive and restore) and `packages/web/tests/product-community.spec.ts` (open a product page). No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (AS-86).
- Contract layer (VII.6): every e2e parses responses with the schema named in the spec (`productMemberSchema`, `productPublicSchema`, `productBatchItemSchema`, `productPageSchema`) and outbox payloads with `productEventSchemas`.

Abbreviations for the e2e files (all under `libs/domains/catalog/`):

| Key | File | Top-level `describe` |
|---|---|---|
| W | `product-write.e2e-spec.ts` | `Product write API` |
| R | `product-read.e2e-spec.ts` | `Public product read API` |
| C | `product-cache.e2e-spec.ts` | `Product cache behaviour` |
| I | `product-invalidation.e2e-spec.ts` | `Product cache invalidation` |
| Q | `product-query-stock.e2e-spec.ts` | `Product query and stock services` |
| X | `product-import.e2e-spec.ts` | `Product external upsert and commands` |
| V | `product-views.e2e-spec.ts` | `Product views write-behind` |
| L | `product-shop-lifecycle.e2e-spec.ts` | `Product and shop lifecycle` |
| E | `product-events.e2e-spec.ts` | `Product events and operations` |
| B | `product-boundary.e2e-spec.ts` | `Catalog module boundary` |

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create | W: member creates, row, outbox, view, no internal fields | `seller.spec.ts` add a product | `domain/product-input.spec.ts` tag normalisation table |
| AS-02 create validation classes | W: table-driven over every class, nothing persisted | — | — |
| AS-03 currency | W | — | — |
| AS-04 who may write | W: 401, `VIEWER` 403, non-member and unknown shop identical 404 | — | — |
| AS-05 shop status gate | W: `SUSPENDED` 403, `DELETING` 409 (HTTP) | — | — |
| AS-06 removed routes | W: both routes 404 | — | — |
| AS-07 update | W: 200, version, `changedFields`, outbox, cache already deleted | `seller.spec.ts` edit price and stock | — |
| AS-08 update validation | W: table-driven | — | — |
| AS-09 no-op update | W: no write, no event, stale version beats no-op | — | — |
| AS-10 stale version | W: `PATCH`, `archive`, `restore` each 409 with `currentVersion` | — | — |
| AS-11 concurrent edits | W: `Promise.all` of two `PATCH`; one 200, one 409, one event | — | — |
| AS-12 cross-shop access | W: matrix of `GET`/`PATCH`/`archive`/`restore` x two paths, identical 404 bodies | — | — |
| AS-13 read one as member | W: roles incl. `VIEWER`, archived visible, 404, 400 | — | — |
| AS-14 list paging | W: 45 products, tie-break, insert between pages, bad limits and cursors | — | — |
| AS-15 list filters | W: `status`, `category`, `inStock`, combined, unknown values | — | — |
| AS-16 archive | W: status, history row, event, public 404, batch `null` | `seller.spec.ts` archive | — |
| AS-17 restore | W: status, history, event, public 200 again | `seller.spec.ts` restore | — |
| AS-18 illegal transitions | W: archive archived, restore active → 409 | — | — |
| AS-19 edit while archived | W: 409 `product_archived`, then OK after restore | — | — |
| AS-20 archive races edit | W: `Promise.all`; one winner; consistent final row | — | — |
| AS-21 status machine | — | — | `domain/product-status.spec.ts` (`it.each` over every pair, `assertNever`) |
| AS-22 write rate limit | W: 121st write 429 + `Retry-After`, reads fine; limiter store down → 503 (fault proxy) | — | — |
| AS-23 detail | R: body, headers, one entry cached, view counted | `product-community.spec.ts` open a product page | — |
| AS-24 conditional request | R: 304, then new ETag after update | — | — |
| AS-25 hidden products | R: archived, sandbox, suspended/deleting/deleted shop, unknown: identical 404 | — | — |
| AS-26 malformed ID | R: 400 with zero statements and no cache access | — | — |
| AS-27 cache-aside | C: miss (1 statement) then hit (0), write deletes | — | — |
| AS-28 avalanche | C: 200 entries, every entry has a TTL, within ±10%, ≥ 10 distinct | — | — |
| AS-29 stampede | C: 100 concurrent on one instance = 1 statement; two instances ≤ 2 | — | — |
| AS-30 stale-while-revalidate | C: clock +61 s, 100 concurrent served at once, one refresh; +361 s miss | — | — |
| AS-31 negative caching | R: 404 twice = 1 statement; after +13 s again | — | — |
| AS-32 read rate limit / penetration | R: 700 random IDs from one address; 600 × 404 then 429 | — | — |
| AS-33 limiter store down | R: reads served (fail open), failure counted | — | — |
| AS-34 cache down, fallback | C: refuse and hang modes, 200 within 2 s, no view, repopulates; `PATCH` 200 with cache down | — | — |
| AS-35 database down, warm cache | C: lock/stop DB: warm 200, cold 503 generic problem+json | — | — |
| AS-36 hot key | C: two instances, 200 reads, L1 hits, Redis `GET` count flat, update visible on both within 1 s | — | — |
| AS-37 big keys | C: max-size product, entry ≤ 32 KiB, only per-product keys | — | — |
| AS-38 batch read (R2) | R: order, nulls, duplicates, 100 cold = 1 statement, 400s, headers, 429 | — | — |
| AS-39 delete-on-write | I: after each kind of write the entry is gone before the response; immediate read fresh | — | — |
| AS-40 event-driven invalidation | I: writer delete failed (cache down), event repairs; own consumer group | — | — |
| AS-41 duplicate event | I: deliver twice, one `applied`, one `skipped`, no extra miss | — | — |
| AS-42 out-of-order events | I: v5 then v4, v4 ignored | — | — |
| AS-43 slow reader race | I: gated loader stores v3 after v4 invalidation → refused | — | — |
| AS-44 invalid event | I: bad `aggregateId`, unknown type, bad payload in a batch → DLQ, rest applied | — | — |
| AS-45 coalescing | I: 10 events, 3 products → 3 invalidations with highest versions | — | — |
| AS-46 invalidation lag | I: histogram value, p99 under 5 s over 100 events | — | — |
| AS-47 product deleted event | I: entry removed, next read 404 | — | — |
| AS-48 batch read (R1) | Q: map, archived included, one statement, empty, 501 refused | — | — |
| AS-49 source of truth | Q: stale entry vs `getProductsByIds` | — | — |
| AS-50 tenant predicate | Q: `{shopId}` filters | — | — |
| AS-51 stock delta applied | Q: row, record, event, cache entry deleted | — | — |
| AS-52 insufficient stock, atomic | Q: two-item call, nothing applied | — | — |
| AS-53 no oversell | Q: `Promise.all` 10 × `-1` on 5; 2 × `-3` on 5 | — | — |
| AS-54 idempotent replay | Q: replay and conflicting replay | — | — |
| AS-55 concurrent replay | Q: two identical concurrent calls | — | — |
| AS-56 unavailable and foreign | Q: archived negative/positive, wrong shop, unknown | — | — |
| AS-57 stock input limits | Q: table-driven | — | — |
| AS-58 storage backstop | Q: fixture writes `-1` and duplicate sku, both refused by the database | — | — |
| AS-59 delta rule | — | — | `domain/stock-rule.spec.ts` (`it.each` edges + `fast-check` prefix sums) |
| AS-60 external upsert | X: created / unchanged / updated | — | — |
| AS-61 concurrent upsert | X: `Promise.all` same sku, one row, no unique error | — | — |
| AS-62 per-item results | X: 3 valid + 2 invalid, limits | — | — |
| AS-63 upsert rules | X: archived stays, no quantity, two shops, inactive shop | — | — |
| AS-64 command parity (R1) | X: same errors and events as HTTP; controllers call only these services | — | — |
| AS-65 operation retention | E: purge job with frozen clock | — | — |
| AS-66 count and flush | V: 5 views, flush, row and pending, version unchanged | — | — |
| AS-67 flush failure | V: trigger raises, restore, exact 5 afterwards | — | — |
| AS-68 views during a flush | V: concurrent reads and drain | — | — |
| AS-69 chunks | V: 2,500 products, 3 statements, failure in chunk 2 | — | — |
| AS-70 deleted product | V | — | — |
| AS-71 two workers | V: two concurrent runs | — | — |
| AS-72 cache down | V: read ok, not counted, logged | — | — |
| AS-73 what is not counted | V: 404, 400, 429, hidden, batch | — | — |
| AS-74 no write amplification | V: no outbox row, no entry deleted, versions unchanged | — | — |
| AS-75 schedule | V: registered with 10 s cron; one run per tick with two schedulers | — | — |
| AS-76 suspension hides products | L: 2,500 products, batches ≤ 1,000, reinstate, stale `shopVersion` ignored | — | — |
| AS-77 shop purge | L: batches ≤ 500, events, dependants gone, other shops intact, duplicate, resume | — | — |
| AS-78 invalid shop events | L: DLQ, no side effect | — | — |
| AS-79 shop-id backfill | L: ≤ 200 sellers per call, batches, events, rerun, concurrent runs | — | — |
| AS-80 ownership constraints | L: `NOT NULL` enforced, no FK to shop or user (catalog of foreign keys) | — | — |
| AS-81 sandbox shops | L: flag stamped, events carry it, never public | — | — |
| AS-82 event contract | E: parse every outbox payload; version +1 per product; no-op writes none | — | — |
| AS-83 atomicity with the outbox | E: trigger makes the outbox insert fail → full rollback, no entry deleted | — | — |
| AS-84 timeouts | C: table lock → cold read 503 within 3 s, warm still served | — | — |
| AS-85 observability | E: log fields, metrics move, problem+json members | — | — |
| AS-86 boundary, static | static gates in CI: `check:table-ownership --strict`, `check:boundaries`; B: a test module importing only the entry point compiles and resolves every R1 service | — | — |
| AS-87 removed search routes | B: catalog modules alone answer 404 for both search routes | — | — |

## Coverage notes

- Every edge case of the notes appears once: stampede (AS-29), stale-while-revalidate (AS-30), avalanche (AS-28), penetration (AS-26, AS-31, AS-32), hot keys (AS-36), big keys (AS-37), delete-on-write and its race (AS-39–AS-43), write-behind (AS-66–AS-75), concurrency (AS-11, AS-20, AS-53, AS-55, AS-61, AS-71), idempotent replay (AS-54, AS-55, AS-60), illegal transitions (AS-18, AS-19, AS-21), cross-tenant access (AS-04, AS-12, AS-50), limits (AS-02, AS-14, AS-57, AS-62), timeouts (AS-34, AS-84), duplicate and out-of-order events (AS-41, AS-42, AS-77).
- VII.9 fallback gate: AS-34 (cache down), AS-35 (database down), AS-33 (limiter store down), AS-22 (fail closed) and AS-67 (flush failure) each force the degradation path.
- The pure logic that the e2e suite cannot reach cheaply (status machine, stock rule, tag normalisation) is covered once in `domain/`.
- Moving or deleting existing tests (`[BREAKING]`): the search cases of `product.e2e-spec.ts` move to S32; the file is replaced by the files above.
