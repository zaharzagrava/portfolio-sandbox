# Gaps: S40 — current `seller-insights` code (leaderboards, dashboard, stats) versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/seller-insights/` unless stated; line numbers are those read on 2026-10-06. Crawler files (`crawler.*`, `application/crawler.service.ts`, `infra/frontier.ts`, `domain/robots.ts` and friends) belong to **S41** and are not listed except where debt rows name them. Questions behind each row are in [`questions.md`](questions.md); scenario IDs refer to [`spec.md`](spec.md).

Note on section C: `pnpm --dir packages/backend check:table-ownership` could not be executed in the unattended session that wrote this file (the command was not approved). The rows are derived by reading every import, `@InjectModel`, and SQL string of the domain; re-run the command first and reconcile.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Revenue is `price × quantity` (pre-discount); the event's `lineTotalMinor` is ignored; amounts are plain numbers named `price`, `total` | `infra/leaderboard.projector.ts:48-52`, `infra/shop-live.projector.ts:43`, `infra/shop-sales.projector.ts:35` | FR-002, AS-01 |
| A2 | The tie-breaker is rebuilt from the latest event's own instant on each sale, so an older event delivered later moves a shop's "last sale" back; the final board depends on delivery order | `infra/leaderboard.lua.ts:19-22`, `infra/leaderboard.projector.ts:62` | FR-004, AS-05, AS-12 |
| A3 | No final deterministic tie rule beyond what the sorted set yields; not specified or tested | `infra/leaderboard.lua.ts:22`, `domain/periods.ts:43-46` | FR-004, AS-06, AS-27 |
| A4 | `paidAt` is not used; the envelope's `occurredAt` decides the period | `infra/leaderboard.projector.ts:39` | FR-005, AS-07, AS-08 |
| A5 | Events are read with `OrderPaid.match`, no schema validation of the payload, no dead letter for invalid, non-`EUR`, negative, unsupported-version messages; a line without `shopId` is skipped silently | `infra/leaderboard.projector.ts:31`, `infra/shop-live.projector.ts:36-46`, `infra/shop-sales.projector.ts:26` | FR-007, AS-10 |
| A6 | A period with a frozen snapshot still accepts events; there is no `sealed` outcome | `infra/leaderboard.projector.ts:46-71` | FR-005, AS-09 |
| A7 | No revenue ceiling check: a shop at `2^33` minor units silently loses tie bits or precision; no all-or-nothing rejection | `infra/leaderboard.lua.ts:22`, `domain/periods.ts:36-46` | FR-006, AS-13, AS-14 |
| A8 | `scoreFor`/`revenueFromScore` exist but the projector duplicates the arithmetic in Lua; the unit-level rule is untested (`domain/` has only `crawler.spec.ts`) | `domain/periods.ts:43-48` | AS-07, AS-14, AS-29 |
| A9 | Zero-revenue lines create a board entry (`HINCRBY 0` + `ZADD`) | `infra/leaderboard.projector.ts:48-59`, `infra/leaderboard.lua.ts:21-22` | FR-002, AS-15 |
| A10 | An unknown product (no category) silently counts on the overall board only, with no outcome counter or log; an unusual category string is normalised by replacing characters with `-` and has no length limit | `infra/leaderboard.projector.ts:34-35,53`, `infra/leaderboard-keys.ts:12` | FR-008, AS-11, AS-19 |
| A11 | Category comes from reading the `Product` table on every batch; no category read model, no version guard, no `category_unresolved` outcome | `infra/leaderboard.projector.ts:34-36`, `infra/shop-sales.projector.ts:29` | FR-008, AS-11, AS-59 |
| A12 | Key expiry is set per call from `Date.now()`, with a minimum of 60 s (`Math.max(ttl, 60)`); a late event for an old period can set a short or odd expiry; no test of "no key without TTL" | `infra/leaderboard.projector.ts:13,63,65` | FR-010, AS-16 |
| A13 | No metrics or lag gauge; the only log is a warning in the ticker | whole domain; `infra/dashboard-ticker.service.ts:36` | FR-046, AS-61 |
| A14 | The public top list returns revenue per shop and a name placeholder `"Unknown shop"`; response is an untyped object, no contracts schema | `application/leaderboard.service.ts:12-14,37,51,74` | FR-012, FR-014, FR-044, AS-17, AS-20 |
| A15 | Bad period id throws a plain `Error` (→ 500); `limit` is silently clamped; no `422 period_in_future`; unknown and repeated query parameters accepted; `period` error is a `BadRequestException('period: week \| month')` string | `domain/periods.ts:32`, `api/leaderboards.controller.ts:9-13,27-29,33-35` | FR-013, AS-19 |
| A16 | Query params are read with `@Query('x')` strings, no DTO or zod schema | `api/leaderboards.controller.ts:27,33` | FR-012, FR-044 |
| A17 | "My rank" is anonymous and public and returns the shop's revenue; wrong route, no shop gate; a missing rank is `NotFoundException('No sales in this period')` without a code | `api/leaderboards.controller.ts:31-35`, `application/leaderboard.service.ts:41-52` | FR-018–FR-020, AS-24–AS-26 |
| A18 | `rank` between `ZREVRANK`, `ZCARD`, `HGET` are three separate calls (`Promise.all`), so rank/of/revenue can come from different moments under writes; `topPercent` unit-untested | `application/leaderboard.service.ts:44-51` | FR-018, FR-021, AS-27, AS-29 |
| A19 | Rank in a frozen period is not supported; snapshot is only a fallback when the live board is empty, and only for the top list | `application/leaderboard.service.ts:33,55-62` | FR-016, FR-019, AS-22, AS-28, AS-30 |
| A20 | No rate limit on the public routes; `Cache-Control` is one fixed header for every period | `api/leaderboards.controller.ts:24-26,31-32` | FR-015, FR-016, AS-21, AS-22 |
| A21 | No timeout on the board store calls, no `503` mapping, no handling for the store being unreachable | `application/leaderboard.service.ts:32-51` | FR-016, FR-045, AS-23 |
| A22 | Shop names are loaded with one `SELECT name FROM "Shop"` per shop through the cache, plus `LEFT JOIN "Shop"` in the snapshot read (cross-domain SQL) | `application/leaderboard.service.ts:56-61,64-75` | FR-014, FR-042, AS-20, AS-58 |
| A23 | Snapshot job freezes any period at any time (the e2e freezes the open week), no `period_not_closed`/`invalid_period`, no grace, no catch-up of missed periods | `infra/leaderboard-snapshot.jobs.ts:38-41`, `leaderboards.e2e-spec.ts:88-90` | FR-024, FR-025, AS-31, AS-32, AS-34 |
| A24 | Snapshot rows have no shop name and no `participants`; two statements per board (`DELETE` then `INSERT … unnest`) with array literals built by string concatenation of ids and revenues | `infra/leaderboard-snapshot.jobs.ts:47-56` | FR-022, FR-026, AS-31, AS-36 |
| A25 | The snapshot job reads all boards of one period from Redis in a loop, one transaction per board; concurrent runs and the "reader never sees empty" guarantee are not tested | `infra/leaderboard-snapshot.jobs.ts:43-58` | FR-023, AS-33 |
| A26 | Live counters: the event is marked seen (`SET NX 600 s`) before the increments; a crash between the two loses the event for good; the mark is per event with a 10-minute TTL (replays later than that double count) | `infra/shop-live.projector.ts:27-55` | FR-029, AS-41 |
| A27 | No age check: an event older than 60 s still writes a bucket with a 180 s expiry and refreshes `dash:active` | `infra/shop-live.projector.ts:28,48-55` | FR-030, AS-39 |
| A28 | Reserved and paid shop ids are de-duplicated with a `Set` (correct) but untested; `null` shop ids are dropped silently with no outcome counter | `infra/shop-live.projector.ts:37,45` | FR-028, AS-38 |
| A29 | The ticker only visits shops with sales in the last 60 s (`dash:active`), so idle subscribed shops get no frame and panels freeze at the last non-zero frame | `infra/dashboard-ticker.service.ts:46-47` | FR-031, AS-42 |
| A30 | Ticker uses raw `PUBSUB NUMSUB` per shop in a serial loop (await per shop), computing and publishing one at a time; no per-tick budget | `infra/dashboard-ticker.service.ts:49-57` | FR-031, FR-032, AS-42 |
| A31 | `setInterval` ticks can overlap when one runs longer than a second; no `ticks_skipped` metric | `infra/dashboard-ticker.service.ts:35-38` | FR-032, AS-44 |
| A32 | Shutdown only `clearInterval`s; a tick in progress is not awaited and leases are not released | `infra/dashboard-ticker.service.ts:40-42` | FR-032, AS-49 |
| A33 | The frame has `last60s.revenue` and no `shopId`, `windowSeconds` or currency; `checkoutConversion` rounded to 3 decimals is implemented inline and unit-untested | `infra/dashboard-ticker.service.ts:11-16,70` | FR-031, AS-37, AS-40 |
| A34 | The topic `shop:{id}:live` is registered and its policy defined by tenancy (correct owner, S03 AS-83); this domain has no test that frames stay inside their shop or that a non-member is refused | `libs/domains/tenancy/api/realtime-topics.ts:16`; `leaderboards.e2e-spec.ts` (no subscriber test) | FR-033, AS-45 |
| A35 | Today chart: no `day`, string `minute` without `T`/`Z`, `revenue` in unknown unit, no schema; totals computed in JS | `application/shop-dashboard.service.ts:10-19` | FR-034, AS-46 |
| A36 | The minute view counts `uniqExact(order_id)` per insert block and `SummingMergeTree` adds blocks: an order split over two insert batches counts twice, a redelivered batch counts twice (the base table's `ReplacingMergeTree` does not deduplicate the view) | `clickhouse/050_shop_sales.sql:22-33`, comment `infra/shop-sales.projector.ts:11` | FR-034, FR-039, AS-46, AS-55 |
| A37 | `shop_sales` sort key `(shop_id, ts, order_id, product_id)` makes dedupe depend on identical `ts`; a redelivery with another timestamp is a new row | `clickhouse/050_shop_sales.sql:12` | FR-039, AS-55 |
| A38 | No title, no buyer id, no refund fact in `shop_sales`; stats cannot be derived from it | `clickhouse/050_shop_sales.sql:4-13`, `infra/shop-sales.projector.ts:30-37` | FR-037–FR-039, AS-50, AS-53 |
| A39 | The "today" and stats ClickHouse calls have no timeout or `503` mapping; errors surface as 500 | `application/shop-dashboard.service.ts:10`, `application/seller-stats.service.ts:35` | FR-036, AS-48 |
| A40 | Seller stats: wrong route (`/sellers/me/stats`, role `SELLER`), reads `seller_sales`, which no code writes (only the load-test seeder, per the SQL header), rolling window, sparse `daily`, `revenueCents` names, no refund amount, no title, no schema | `api/seller-stats.controller.ts:12-20`, `application/seller-stats.service.ts:30-103`, `clickhouse/001_seller_sales.sql:1-5`, `api/seller-stats.dto.ts` | FR-037–FR-040, AS-50–AS-57 |
| A41 | `days` is validated with `class-validator` (integer 1–365) but there is no e2e for each invalid class, unknown parameters are not shown to be rejected, and the `400` body has no tested field-error contract | `api/seller-stats.dto.ts:5-13` | FR-037, AS-51 |
| A42 | The stats service applies its DDL from `process.cwd()` at `onModuleInit` and swallows failures with a warning | `application/seller-stats.service.ts:7,21-28` | FR-044, Q (BREAKING) |
| A43 | The average order value uses `Math.round` (half up for positives) but is not unit-tested; refunds are counted from `status = 'REFUNDED'` rows, which only a seeder writes, so `refunds` is always `0` in production | `application/seller-stats.service.ts:44-48,91` | FR-038, AS-56 |
| A44 | No consumer of `order.refunded`; no refund facts per shop | whole domain | FR-039, AS-53 |
| A45 | No consumer of `tenancy.shop_created/updated/deleted` or `catalog.product_*`; no read models; no erasure | whole domain | FR-008, FR-014, FR-043, AS-58–AS-60 |
| A46 | Modules: `LeaderboardsModule` declares the HTTP controller for three unrelated routes (leaderboards, rank, dashboard "today"), `SellerStatsModule` is separate; the worker module owns the ticker and the snapshots; the projectors are exported as classes and wired in `apps/projector` | `leaderboards.module.ts:10-16`, `seller-stats.module.ts`, `index.ts:11-13`, `apps/projector/src/projector.module.ts:9,52` | FR-042, AS-62, D-8 |
| A47 | The e2e spec injects `ProductModel` and `ShopModel`, calls projectors directly (never through the event path), freezes the open week, reads Redis keys with `KEYS` in `beforeEach`; no spec for rank auth, stats, snapshots as jobs, refunds, shop deletion, rate limit, 503 | `leaderboards.e2e-spec.ts:10-11,20-23,47-52,88-91` | VII.2–VII.4, all |
| A48 | `contracts` has no schemas for these responses or for the frame | `packages/contracts` (none found) | FR-044, VII.6 |
| A49 | No code removes a shop's data when it is deleted | whole domain | FR-043, AS-60 |
| A50 | The `leaderboard.lua.ts` script is one string with positional `ARGV` packing (quadruples); no test of the script at the boundary values, no `sealed` check | `infra/leaderboard.lua.ts:1-27` | FR-003, FR-005, FR-006 |
| A51 | `scripts/load-tests/seller-stats.test.js` and the web client call the old route and old field names | `packages/backend/scripts/load-tests/seller-stats.test.js`, `packages/web/lib/api/shops.ts:59-61` | BREAKING (route, names) |

## B. Debt register rows (`docs/architecture/debt-register.md`) that name `seller-insights` or apply to it

| Row | What | In this domain | Replaced by |
|---|---|---|---|
| D-6 (I.2) | `api/` and `application/` import `infra/` directly; `seller-insights/crawler.module.ts` declares `CompetitorController` inline | `application/leaderboard.service.ts:6` imports `../infra/leaderboard-keys` and queries the Redis client and Sequelize directly; `application/shop-dashboard.service.ts` and `application/seller-stats.service.ts` run ClickHouse queries inside `application/`; crawler part is S41 | repository ports in `domain/` (`BoardRepository`, `SnapshotRepository`, `SalesHistoryRepository`, `LiveCounterRepository`) with adapters in `infra/`; application services call the ports |
| D-7 (IX.4) | Other domains' `*Model` exports | `ProductModel` injected by `infra/leaderboard.projector.ts:4,27` and `infra/shop-sales.projector.ts:4,20`; `ProductModel`/`ShopModel` imported by `leaderboards.e2e-spec.ts:10-11` | R3 product category read model (FR-008) fed by `catalog.product_*`; tests seed through fixtures and exported services |
| D-8 (X.4) | Barrels export infrastructure internals | `index.ts:11-13` exports `LeaderboardProjector`, `ShopLiveProjector`, `ShopSalesProjector` for `apps/projector` | export one `SellerInsightsProjectorModule` (and the core and worker modules) and wire that in the apps |
| D-12 (IX.4) | Raw SQL on tables owned by another domain | `application/leaderboard.service.ts:58` (`LEFT JOIN "Shop"`) and `:69` (`SELECT name FROM "Shop"`) | **R3** shop read model (FR-014): lists and snapshot names come from S40's own table fed by `tenancy.shop_created/updated`; the snapshot stores the name (A24) |

## C. `check:table-ownership` lines for this domain (derived by reading; re-run to confirm)

| File:line | Kind | What | Mechanism that replaces it |
|---|---|---|---|
| `application/leaderboard.service.ts:58` | SQL | `LEFT JOIN "Shop"` in the snapshot read | **R3**: snapshot rows carry the shop name; live names from S40's shop read model |
| `application/leaderboard.service.ts:69` | SQL | `SELECT name FROM "Shop" WHERE id = :id` per shop | **R3**: one batched read of S40's shop read model |
| `infra/leaderboard.projector.ts:4,27,35` | MODEL | `ProductModel` injected, `findAll` for `category` | **R3**: product category read model from `products.events` snapshots |
| `infra/shop-sales.projector.ts:4,20,29` | MODEL | `ProductModel` injected, `findAll` for `category` | **R3**: same read model (or drop the `category` column of the facts) |
| `leaderboards.e2e-spec.ts:10,11,54` | MODEL | test imports `ProductModel`, `ShopModel` | shared fixtures `createShop`, `createProduct` (tests may touch every table, IX.6) |
| `api/leaderboards.controller.ts:4` and `crawler.module.ts:11` | import | `ShopScoped` from `@app/domains/tenancy` | allowed (exported guard, IV.1); no change |
| `infra/leaderboard.projector.ts:8`, `infra/shop-live.projector.ts:5`, `infra/shop-sales.projector.ts:9` | import | `OrderPaid`, `OrderReserved` classes from `@app/domains/orders` | consume the event schemas from `packages/contracts` (S10), not the orders barrel |

(`application/crawler.service.ts:70,155` is S41's: `Product` and `ShopMembership` SQL → R1 `getProductsByIds` and `MembershipQueryService`.)

## D. Missing pieces (new work)

1. **Contracts** (`packages/contracts`): `leaderboardPageSchema`, `shopRankSchema`, `dashboardTodaySchema`, `sellerStatsSchema`, `liveDashboardFrameSchema`, and the event schemas S40 consumes (`order.paid`, `order.reserved`, `order.refunded`, `catalog.product_*`, `tenancy.shop_*`).
2. **Read models**: S40-owned shop (id, name, slug, version) and product (id, shop, category, version) tables with registry entries in `db/ownership.ts`, version-guarded upserts, replayable consumers, deletion on `shop_deleted`. Migration with `lock_timeout` (III.11).
3. **Board feed**: atomic per (order, period) apply with `lineTotalMinor`, latest-sale-instant semantics, ceiling check, sealed-period check, outcome counters; move period/ranking-key arithmetic to `domain/` and test it (AS-07, AS-14, AS-29).
4. **Snapshots**: columns `shopName`, `participants`; atomic replace of one board; due-time and catch-up rules; `period_not_closed`/`invalid_period`; renumbering on shop deletion.
5. **Reads**: top list and rank as in FR-012–FR-021 (frozen periods from the snapshot), strict query DTOs, rate-limit policy, timeouts, `503` mapping.
6. **Live dashboard**: atomic per-event apply, stale-event guard, subscribed-shop discovery through S51, one-lease-per-shop ticker with non-overlapping ticks and clean shutdown (the topic and its policy already exist in tenancy).
7. **Analytics facts**: one fact table fed by `order.paid` (sale facts with title, buyer, revenue) and `order.refunded` (refund facts per shop), idempotent by `(orderId, productId)`, read through an exact (deduplicating) query; "today" and stats from it; DDL as migration step; drop `seller_sales` and `clickhouse/001_seller_sales.sql`; update the load-test seeder and its k6 script.
8. **Routes**: `GET /shops/:shopId/rank`, `GET /shops/:shopId/stats`, keep `GET /shops/:shopId/dashboard/today` (new shape); remove `GET /leaderboards/shops/:shopId` and `GET /sellers/me/stats`; update `packages/web/lib/api/shops.ts` and the W04 spec.
9. **Tests**: the eight e2e files and five unit files of `test-plan.md`; remove `KEYS` use from tests (use the registry of keys the domain exposes to tests or flush by prefix with `SCAN`).
10. **Boundary**: projector module export instead of classes; ports in `domain/` (D-6); entry point export test (AS-62).

## E. Suggested order of work

1. Contracts and domain arithmetic (`periods`, ranking key, percent, conversion, average order value) with their unit specs.
2. Read models (shop, product) and their consumers (AS-58, AS-59).
3. Board feed and board reads, then rank, then snapshots (AS-01–AS-36).
4. Live counters, ticker, topics module (AS-37–AS-45, AS-49).
5. Analytics facts, "today", stats, refunds (AS-46–AS-48, AS-50–AS-57).
6. Shop deletion, observability, static gates (AS-60–AS-62); update web client and k6 script.
