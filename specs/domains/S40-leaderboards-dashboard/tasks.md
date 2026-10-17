# Tasks: S40 — Seller Leaderboards, Live Sales Dashboard, Seller Stats (`seller-insights`)

**Input**: `spec.md`, `plan.md`, `research.md` (R-1..R-11), `data-model.md`, `contracts/http-and-events.md`, `test-plan.md` (AS-01..AS-62), `gaps.md` (A1–A51, B, C, D), `questions.md` (defaults accepted), `quickstart.md`.

**Conventions**
- `SI` = `packages/backend/libs/domains/seller-insights`; `CT` = `packages/contracts/src/seller-insights`. Backend commands run from `packages/backend`; e2e through `scripts/sdd/test-spec.sh <path>`.
- Test-first: inside each story the failing test task precedes the code task that makes it pass. Every e2e asserts the response body AND persisted state; no "A or B" assertions (L-003); each test creates its own data (L-005/L-006); only identity, clock and fault injection are faked.
- No new direct `sequelize.transaction` (use `TransactionRunner.run`); migrate `SI/infra/leaderboard-snapshot.jobs.ts:89` and delete its `// S54 T037 audit` comment.
- Runtime checks (fresh stack, standalone boots, journey/browser suite, test_doctor) are deferred to the final checkpoint; no task here runs them. Crawler files (S41) are not touched.
- `[P]` = different files, no dependency on an unfinished task.

---

## Phase 1: Setup (living spec first, WS0)

- [X] T001 Create `docs/spec/capabilities/S40-leaderboards-dashboard.md` (rules and behaviors first): public top list without revenue, shop-scoped rank/today/stats, ties (first to reach, larger shop id on equal key), periods UTC, freezing/`sealed`, live frame, refunds; state that boards, live counters and sales history count `lineTotalMinor` (J01 follow-up); every `[proof: …]`/`[code: …]` points to real tests/files; run `python3 scripts/livespec/check.py`; create no `*.reviewed.json`.
- [X] T002 [P] Confirm `specs/UNVERIFIED.md` rows S40 SC-002, SC-003, SC-005 exist (they do, lines ~262-264, status "not run") and `quickstart.md` "Ops artifacts" lists the same three; add nothing else (SC-001/004/006–009 are proven by AS tests).
- [X] T003 [P] Add test helpers `SI/testing/insights-fixtures.ts` (the folder `testing/` of the sibling domains): `seedShop`/`trio`/`member`/`product` via shared fixtures and exported tenancy services (no `ProductModel`/`ShopModel`/`ShopMembershipModel`, D-7), event builders from `packages/contracts` for `order.paid|reserved|refunded`, `catalog.product_*`, `tenancy.shop_*`, a frozen clock `T0 = 2026-10-06T12:00:00Z`, a Redis key flusher by prefix using `SCAN` (never `KEYS`, gaps D9), fault injection at the store edges, a runner-faithful `deliver`.

## Phase 2: Foundational (blocking: contracts, domain core, migrations, ports, modules)

### Contracts (WS1, A48, D1)
- [X] T004 [P] Create `CT/leaderboard.ts` (`leaderboardPageSchema`: entries `{rank, shopId, slug|null, name|null}`, no revenue; `period`, `id`, `category`, `source: 'live'|'snapshot'`, `closed`), `CT/rank.ts` (`shopRankSchema`: `rank, of, topPercent, revenueMinor`, period fields), `CT/index.ts` exports.
- [X] T005 [P] Create `CT/dashboard.ts` (`dashboardTodaySchema`: `day`, ISO-8601 UTC `minute`, `revenueMinor`, totals), `CT/stats.ts` (`sellerStatsSchema`: `from`, `to`, `currency`, `revenueMinor`, `orders`, `units`, `avgOrderValueMinor`, `uniqueBuyers`, `refundsCount`, `refundedMinor`, `netRevenueMinor`, zero-filled `daily`, `topProducts[{productId,title,…Minor}]`, no buyer identity), `CT/live-frame.ts` (`liveDashboardFrameSchema`: `shopId`, `windowSeconds`, `last60s{checkouts,orders,units,revenueMinor}`, `checkoutConversion`, `at`).
- [X] T006 [P] Create `CT/consumed-events.ts` with the consumed schemas and factories: `order.paid` (uses `paidAt`, `lines[].shopId` non-null, `lineTotalMinor`, `title`, `userId`, `currency = EUR`), `order.reserved`, `order.refunded`, `catalog.product_created|updated|archived|restored|deleted` (`productVersion`, `category`), `tenancy.shop_created|updated|deleted` (`shopVersion`); reuse S10 names (`totalMinor`, `paymentRef`), no `flashsale.*`.

### Pure domain (WS1) — tests first
- [X] T007 [P] Write failing `SI/domain/periods.spec.ts` (`it.each` over the eight AS-07 instants: ids, start, exclusive end, offset input).
- [X] T008 [P] Write failing `SI/domain/ranking-key.spec.ts` (AS-14 table: equal revenue earlier/later/same unit, `0`, `2^33 − 1`, period start, `end − 1 unit`, after end, `≥ 2^33` refused, exact revenue recovery `floor(score/2^20)`; `fast-check` order property).
- [X] T009 [P] Write failing `SI/domain/rank-percent.spec.ts` (AS-29, six pairs), `SI/domain/conversion.spec.ts` (AS-40, six pairs, 3 decimals, may exceed 1), `SI/domain/average-order-value.spec.ts` (AS-56, five pairs, round half up).
- [X] T010 Rewrite `SI/domain/periods.ts` (UTC week/month ids, start/end, `period_in_future`, invalid id as typed `InvalidPeriodError`, not plain `Error`; remove score arithmetic from it) so T007 passes (A8, A15).
- [X] T011 Create `SI/domain/ranking-key.ts`: score = `revenue * 2^20 + (2^20 − 1 − slot)`, slot clamped to `[0, 2^20 − 1]` (seconds for weeks, minutes for months), ceiling `2^33 − 1` → `RevenueLimitExceededError` (R-1) so T008 passes.
- [X] T012 [P] Create `SI/domain/rank-percent.ts`, `conversion.ts`, `average-order-value.ts`, `sale-facts.ts` (event → per-shop/per-category facts using `lineTotalMinor`; zero-revenue lines yield no board entry; category normalisation: lowercase, trim, 1–64 chars, no control characters, else overall only + `category_invalid`), `errors.ts`; T009 passes.
- [X] T013 Create `SI/domain/ports.ts`: `BoardRepository`, `SnapshotRepository`, `LiveCounterRepository`, `SalesHistoryRepository`, `ShopDirectory`, `ProductCategoryDirectory` (D-6).

### Persistence (WS2, D2)
- [X] T014 Create migration `packages/backend/migrations/<ts>-seller-insights-s40-expand.js` with `lock_timeout`: tables `SellerInsightsShop(shopId uuid PK, name text, slug text, shopVersion int, updatedAt)` and `SellerInsightsProduct(productId uuid PK, shopId uuid, category text, productVersion int, updatedAt)` with index on `shopId`; `LeaderboardSnapshot` add `shopName text NULL`, `participants int` (add nullable, backfill `COUNT(*)` per board, then `SET NOT NULL`); the existing primary key `(period, board, rank)` is the unique rank key (see gaps.md, implementation notes). Expand only; no `Shop` join.
- [X] T015 [P] Create models `SI/infra/models/{seller-insights-shop,seller-insights-product,leaderboard-snapshot}.model.ts`; register the three tables with owner `seller-insights` in `packages/backend/db/ownership.ts`.
- [X] T016 [P] Create ClickHouse DDL `packages/backend/clickhouse/051_shop_sale_facts.sql` (`shop_sale_facts(shop_id, order_id, product_id, title, buyer_id, units, line_total_minor, paid_at DateTime64, ingested_at)` ReplacingMergeTree(ingested_at) ORDER BY `(shop_id, order_id, product_id)`, partition by month of `paid_at`; `shop_refund_facts(shop_id, order_id, amount_minor, refunded_at, ingested_at)` ReplacingMergeTree ORDER BY `(shop_id, order_id)`) and the operator script `clickhouse/operator/052_drop_seller_sales.sql` (drop `seller_sales` and the `shop_sales` minute view); delete `clickhouse/001_seller_sales.sql` and `clickhouse/050_shop_sales.sql`; applied by the migration step, never at app start (A36, A37, A38, A42).
- [X] T017 Ensure the `infrastructure/clickhouse` client supports per-call timeout and parameterised queries (questions CONTRACT); extend it if missing. (`ClickHouseService.query(sql, params, {timeoutMs})` and `insert(..., {timeoutMs})` already do; nothing to extend.)

### Module skeleton (WS11)
- [X] T018 Create `SI/seller-insights-projector.module.ts` (static `projectors` list, pattern of `community/feed-projectors.module.ts`), split `SI/leaderboards.module.ts` (reads), `SI/seller-stats.module.ts`, `SI/leaderboards-worker.module.ts` (ticker, snapshot jobs); change `SI/index.ts` to export modules only (no projector classes, D-8); wire the projector module in `apps/projector/src/projector.module.ts` and the worker module in `apps/worker`; the API app imports the read modules (L-018: each app boots on its own with its own imports).

**Checkpoint**: contracts compile, unit specs T007–T009 green, migration written, modules wired.

---

## Phase 3: User Story 7 (P2, built early) — Read models, erasure, shop/product consumers (WS2, WS9)

**Goal**: S40 owns shop name/slug and product category read models; deleting a shop empties every store. **Independent test**: `read-models.e2e-spec.ts`.

- [X] T019 [P] [US7] Write failing `SI/read-models.e2e-spec.ts` describe "Seller insights: shop and product read models, shop deletion": AS-58 (delivery order 2,1,1 holds `Alpha Plus` v2; invalid → dead letter, no effect; same message twice), AS-59 (order 3,1,2,3 holds `tablets` v3; `product_deleted` keeps category; invalid dead-lettered), AS-60 (shop on live boards, snapshot rank 1 of 3, counters, analytics, read models; after `shop_deleted` all gone, snapshot renumbered `1..2`, stats/today `404`, repeat delivery no change).
- [X] T020 [US7] Implement `SI/infra/pg-shop-directory.ts` and `SI/infra/pg-product-categories.ts` (version-guarded upserts `WHERE excluded.version > version` through `TransactionRunner.run`; batched read by ids).
- [X] T021 [P] [US7] Implement `SI/infra/projectors/shop.projector.ts` (group `seller-insights-shops`; missing `shopId` or bad `shopVersion` → DLQ `invalid_payload`) and `SI/infra/projectors/product.projector.ts` (group `seller-insights-products`, topic `products.events`, compacted-topic replay, tombstone state keeps last category; missing `productId` → DLQ). (Both live in `infra/projectors/read-model.projectors.ts`.)
- [X] T022 [US7] Implement `SI/application/erasure.service.ts` + `SI/infra/projectors/erasure.projector.ts` on `tenancy.shop_deleted`: delete the shop from every board zset/hash (all periods and categories), live keys, ClickHouse sale/refund facts, both read models, `SellerInsightsShop`; snapshot rows deleted and renumbered with one `row_number()` statement; idempotent on repeat (AS-60, A49). (The erasure consumer is `ShopErasureProjector` in `read-model.projectors.ts`.)

---

## Phase 4: User Story 1 (P1) — Boards stay correct while sales stream in (WS3)

**Goal**: exactly-once, order-independent, replayable boards from `order.paid`. **Independent test**: `leaderboard-feed.e2e-spec.ts` (AS-01–AS-16).

- [X] T023 [US1] Write failing `SI/leaderboard-feed.e2e-spec.ts` describe "Leaderboards: board feed (idempotency, ties, periods, replay, limits)" through the real projector module: AS-01 (`lineTotalMinor`, overall/`electronics`/`accessories`, week+month, counter `applied` 2), AS-02 (redelivery once/twice at once/ten at once, `duplicate` 26), AS-03 (50 orders × 10 workers, `A = 5000`), AS-04 (three ties phases), AS-05 (both delivery orders identical), AS-06 (week `[A,C,B]`, month `[C,B,A]`, ten repeated reads), AS-08 (`paidAt` decides period), AS-10 (seven bad messages dead-lettered with reasons, next valid applied, foreign type ignored; same batch through live and history consumers), AS-11 (`category_unresolved`, v1/v2/stale, no retro-attribution), AS-12 (200 events, empty store, shuffled replay twice, byte-equal), AS-13 (all-or-nothing, `revenue_limit_exceeded`), AS-15 (zero revenue), AS-16 (expiry = period end + 35 d ± 1 s on every key, none without).
- [X] T024 [US1] Implement `SI/infra/board.lua.ts`: one script per `(order, period)`: sealed check (`lb:sealed:{period}`), `SADD lb:applied:{period}`, ceiling check on all boards before any write, `ZADD` with ranking key from `max(previous slot, new slot)` kept in `lb:last:{period}`, revenue in `lb:rev:{period}`, TTL = period end + 35 d on every key; returns outcome (A2, A3, A6, A7, A9, A12, A50).
- [X] T025 [US1] Implement `SI/infra/redis-board.repository.ts` (`BoardRepository` port, 500 ms timeout, typed `BoardStoreUnavailableError`) and `SI/infra/projectors/board.projector.ts` (contract-schema validation; `paidAt` decides periods; DLQ reasons `invalid_payload|unsupported_version|unsupported_currency|revenue_limit_exceeded`; foreign types ignored; resolve category through `ProductCategoryDirectory`; counters `applied|duplicate|sealed|category_unresolved`); delete the old `infra/leaderboard.projector.ts`, `leaderboard.lua.ts`, `leaderboard-keys.ts` and their `ProductModel`/`OrderPaid` imports (A1, A4, A5, A10, A11, C rows).

---

## Phase 5: User Story 2 (P1) — Public top list (WS4)

**Independent test**: `leaderboard-read.e2e-spec.ts` AS-17–AS-23.

- [X] T026 [US2] Write failing `SI/leaderboard-read.e2e-spec.ts` describe "Leaderboards: public top list and my rank" (top-list part): AS-17 (anonymous, schema-parsed, no revenue/extra fields, Cache-Control), AS-18 (category case, month, `id`, `limit`, empty valid category, default 20/max 100), AS-19 (each invalid class `400 validation_failed`, unknown/repeated params rejected, `2026-W50` `422 period_in_future`, problem+json), AS-20 (rename v2, stale v1 ignored, missing row `name: null, slug: null`), AS-21 (61st request `429` + `Retry-After`, other address `200`, limiter store down serves and counts `rate_limit_degraded`), AS-22 (frozen → `source: "snapshot"`, `closed: true`, long cache, later live change invisible), AS-23 (board store down: current `503` + `Retry-After: 5` within 1 s, generic detail; frozen `200`).
- [X] T027 [P] [US2] Create `SI/api/query-dtos.ts` (strict zod over `req.query`: arrays/unknown keys rejected, `period`, `id`, `category`, `limit` 1–100 default 20, `days` 1–365 default 30) and `SI/api/rate-limit-policies.ts` (`seller-insights.leaderboard-read.ip`, 60/min, fail open, registered like community's) (A15, A16, A20).
- [X] T028 [US2] Implement `SI/application/leaderboard-read.service.ts` (snapshot-first for frozen periods, live board otherwise; names from `ShopDirectory` in one batched read; 503 mapping; `period_in_future`) and rewrite `SI/api/leaderboards.controller.ts` (`GET /leaderboards`, public; Cache-Control `public, max-age=10, s-maxage=30` live / `public, max-age=3600, s-maxage=86400` frozen); remove `application/leaderboard.service.ts` and its `"Shop"` SQL (A14, A19–A22, D-12).

## Phase 6: User Story 3 (P1) — My rank (WS4)

- [X] T029 [US3] Extend `SI/leaderboard-read.e2e-spec.ts` (failing first) with: AS-24 (member and viewer of `A`: rank 2 / of 3 / topPercent 67 / revenueMinor 10000, category variant, schema-parsed), AS-25 (`404 not_ranked` for no-sales shop/category/period), AS-26 (stranger/unknown/malformed byte-identical `404 shop_not_found`, `401`, SUSPENDED `200`, DELETED `404`; re-test of S03 shop-status gates), AS-27 (25 shops with three tied; rank equals list position, `of` 25), AS-28 (101 frozen: position 100 `200 rank 100 / of 101 / topPercent 100`, 101 `404 not_ranked`), AS-30 (closed unfrozen week from live board, then from snapshot after freeze).
- [X] T030 [US3] Implement `SI/application/shop-rank.service.ts` (rank/of/revenue in one Lua/`MULTI` call; frozen from snapshot; `ZREVRANK` consistent with top-list tie rule) and `SI/api/shop-rank.controller.ts` (`GET /shops/:shopId/rank`, `ShopScoped('shop.read')`, `Cache-Control: private, no-store`); remove `GET /leaderboards/shops/:shopId` (A17, A18).

## Phase 7: User Story 4 (P2) — Period snapshots (WS5)

- [X] T031 [US4] Write failing `SI/leaderboard-snapshots.e2e-spec.ts` describe "Leaderboards: period snapshots": AS-09 (frozen week unchanged, month `+500`, counters `sealed` 1 / `applied` 1, one warning; it lives in `leaderboard-feed.e2e-spec.ts` and `observability.e2e-spec.ts`), AS-31 (clock `2026-10-05T01:00Z`: three boards, top 100 rows with name/revenue/`participants 101`; month at `2026-10-01T01:00Z`), AS-32 (`00:59:59`, current, future, malformed → `period_not_closed`/`invalid_period`, no rows, existing untouched), AS-33 (re-run, two concurrent, polling reader never sees empty/partial, ranks `1..n`), AS-34 (catch-up oldest first; period without boards skipped with a warning), AS-35 (three boots leave two schedules with the cron expressions; two replicas fire, one run), AS-36 (rename after freeze unchanged; unknown name stored `null`).
- [X] T032 [US4] Implement `SI/infra/pg-snapshot.repository.ts` (`SnapshotRepository`): per board replace in one `TransactionRunner.run` — `pg_advisory_xact_lock` per period, `DELETE` + bulk `INSERT` with bound parameters (no string-built array literals), READ COMMITTED reads; then set `lb:sealed:{period}`; plus `SI/application/snapshot.service.ts` (due = end + 1 h, unfrozen, boards present, top 100 `ZREVRANGE 0..99 WITHSCORES`, `ZCARD` → `participants`, names from `ShopDirectory`) (A23–A25, R-8). (The period is sealed first, then the boards are replaced.)
- [X] T033 [US4] Rewrite `SI/infra/snapshot.jobs.ts` (replace `leaderboard-snapshot.jobs.ts`; delete its `// S54 T037 audit` sequelize.transaction site) registering `seller-insights.snapshot.weekly` (Monday 01:00 UTC) and `.monthly` (day 1 01:00 UTC) through S49 `upsertSchedule`, with catch-up.

## Phase 8: User Story 5 (P1) — Live dashboard (WS6)

- [X] T034 [US5] Write failing `SI/dashboard-live.e2e-spec.ts` describe "Live dashboard: counters, ticker and frames": AS-37 (frame equals stated JSON, contracts schema), AS-38 (S1/S2 counters, duplicate shop id counts once), AS-39 (`T−59`, `T`, `T−60`, `T+2`, stale → `stale` 1, history still receives sale), AS-41 (redelivery once and ten at once unchanged; injected store failure on first attempt, redelivery counted once), AS-42 (real gateway subscriber: one frame/second for 3 s incl. empty, decays to zeros; no subscriber → no frame computed; reconnect no replay), AS-43 (two ticker instances → one frame per second; stop holder, other publishes ≤ 5 s), AS-44 (forced slow tick: next skipped, `ticks_skipped` 1, no overlap), AS-45 (two shops never cross; non-member refused), AS-49 (shutdown during tick finishes, no later frame, leases released, other instance takes over).
- [X] T035 [US5] Implement `SI/infra/redis-live-counter.repository.ts` (`LiveCounterRepository`): Lua script = `SET NX` mark `live:seen:{eventId}:{kind}` (TTL window + 120 s) + `HINCRBY` into `live:{shop}:{second}` (`checkouts, orders, units, revenue`, TTL 180 s) in one call; events older than 60 s → no write, counter `stale`; shop ids de-duplicated per event, null shop ids counted `shop_missing` (A26–A28) and `SI/infra/projectors/live.projector.ts` (`order.paid`, `order.reserved`; schema-validated; DLQ reasons) replacing `infra/shop-live.projector.ts`.
- [X] T036 [P] [US5] Implement `SI/infra/lease.ts` (`SET lease:{shop} instanceId NX PX 3000`, renew while held, release owned on shutdown).
- [X] T037 [US5] Rewrite `SI/infra/dashboard-ticker.service.ts` in `SI/infra/`: each second `RealtimeSubscriptions.topicsWithSubscribers('shop','live')` (S51; on `RealtimeUnavailableError` reuse last discovered list ≤ 10 s from Redis with short TTL), per shop lease, one pipelined read of 60 buckets, pure frame builder (uses `conversion.ts`, `shopId`, `windowSeconds`, `last60s.revenueMinor`), publish `{replay:false}` to `shop:{shopId}:live` event `dashboard`; in-flight flag with `ticks_skipped`; `OnApplicationShutdown` awaits the tick and releases leases; remove `PUBSUB NUMSUB` and `dash:active` (A29–A33, S51 follow-up).
- [X] T038 [US5] Add tenancy-side assertion only inside the test (AS-45) that topic policy from `libs/domains/tenancy/api/realtime-topics.ts` stays unmodified; if a policy gap shows, record it under "Sibling-spec follow-ups" in gaps.md (S03) — do not edit tenancy. (No gap showed; recorded as exercised unchanged.)

## Phase 9: User Story 6 (P2) — Today chart, stats, refunds (WS7)

- [X] T039 [US6] Write failing `SI/dashboard-history.e2e-spec.ts` describe "Live dashboard: today chart and analytics availability": AS-46 (four orders, UTC day, sparse minutes ISO-8601, totals; redelivery and two-batch order unchanged; schema-parsed), AS-47 (stranger/unknown/malformed `404` identical, `401`, viewer/staff/suspended `200`), AS-48 (store unreachable and 3 s timeout on today and stats → `503` + `Retry-After`, generic detail within 4 s; live frames keep flowing).
- [X] T040 [US6] Write failing `SI/seller-stats.e2e-spec.ts` describe "Seller stats: summary, refunds, windows and isolation": AS-50, AS-51 (each invalid `days` class `400`, default 30, `1` and `365`), AS-52, AS-53 (two-shop refund `3000`/`2000`, duplicate and concurrent once, no sale → retried 5 then DLQ `refund_without_sale`, partial amount DLQ `partial_refund_unsupported`, boards and frames unchanged), AS-54, AS-55 (three deliveries incl. after forced compaction, concurrent; empty store + shuffled replay identical), AS-57 (boundary orders vs `days` 1, 2, 3).
- [X] T041 [US6] Implement `SI/infra/clickhouse-sales-history.ts` (`SalesHistoryRepository`): inserts for sale/refund facts, reads aggregate `GROUP BY (order_id, product_id)` with `argMax`/`any` before summing (no `FINAL`, exact before compaction), minute series via `toStartOfMinute(paid_at)`, `uniqExact(buyer_id)`, 3 s timeout, bound parameters.
- [X] T042 [US6] Implement `SI/infra/projectors/sales.projector.ts` (`order.paid` → sale facts, idempotent by `(orderId, productId)`; DLQ per contract) and `SI/infra/projectors/refund.projector.ts` (`order.refunded`: shares from recorded `shop_sale_facts`; no rows → retryable error, 5 attempts with backoff then DLQ; amount ≠ recorded total → DLQ `partial_refund_unsupported`; one refund fact per shop) (A38, A44, R-7); delete `infra/shop-sales.projector.ts`.
- [X] T043 [US6] Rewrite `SI/application/dashboard-today.service.ts` and `SI/application/seller-stats.service.ts` over the port (UTC calendar window of `days` ending today, zero-filled `daily`, `refundsCount/refundedMinor/netRevenueMinor`, `avgOrderValueMinor` via `average-order-value.ts`, 503 mapping, no DDL at start); controllers `SI/api/dashboard.controller.ts` (`GET /shops/:shopId/dashboard/today`) and `SI/api/seller-stats.controller.ts` (`GET /shops/:shopId/stats?days`), both `ShopScoped('shop.read')`, `Cache-Control: private, no-store`; delete `shop-dashboard.service.ts`, `api/seller-stats.dto.ts` (class-validator) and the `/sellers/me/stats` route (A35, A39–A43, D-6).

## Phase 10: Observability, consumers hygiene, clients (WS8, WS10)

- [X] T044 [P] Write failing `SI/observability.e2e-spec.ts` describe "Seller insights: metrics and logs": AS-61 (counters per outcome after replaying the scenarios' inputs, lag gauge, structured logs with `requestId`/`traceId`, no buyer id or payload).
- [X] T045 Implement `SI/application/seller-insights.metrics.ts` (outcome counters `applied|duplicate|sealed|stale|category_unresolved|dead_lettered{reason}|ticks_skipped|rate_limit_degraded`, feed lag gauge) and wire it in every projector/service; structured logs without payloads (A13).
- [X] T046 [P] Update `packages/web/lib/api/shops.ts` (lines ~59-61) to `GET /shops/:shopId/stats` and `/rank` with the `…Minor` names, `from`/`to`; update `packages/backend/scripts/load-tests/seller-stats.test.js` and its seeder to new route/names and to `shop_sale_facts` (A51); keep the web unit/type checks compiling.
- [X] T047 [P] Add same-message-twice and invalid-payload coverage for every `orders.events` consumer to the e2e files above where not yet present (board: T023; live: T034; sales/refund: T040) — J01 follow-up; make sure no payload uses removed S10 names (`total`, `price`, `paymentId`).
- [X] T048 Remove the old `SI/leaderboards.e2e-spec.ts` only after every old scenario has an equivalent in the new files (L-017); drop `ProductModel`/`ShopModel` imports and `KEYS` use. (The file is kept as a short end-to-end smoke of the four old scenarios, rewritten on the new stack and named with AS ids.)

## Phase 11: Polish & static gates (WS11)

- [X] T049 [P] Barrel/entry-point export test `SI/index.e2e-spec.ts` (AS-62; an e2e spec because the barrel needs the ES-module jest flags): only modules exported, no projector classes, no foreign model or table in any source.
- [X] T050 Fix any `pnpm --dir packages/backend check:table-ownership --strict` finding for `seller-insights` (gaps section C: no `ProductModel`, `ShopModel`, `"Shop"` SQL remain), `pnpm check:boundaries` (api → application → domain; infra only behind ports), `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; confirm zero direct `sequelize.transaction` in the domain.
- [X] T051 [P] Update `docs/spec/capabilities/S40-leaderboards-dashboard.md` to final behavior and rerun `python3 scripts/livespec/check.py`.
- [X] T052 [P] Keep `gaps.md` "Sibling-spec follow-ups" (S10, S03, S05, S51, S49, W04, J02, S09/S11/S13/S14/S23 not consumed) current, and "Spec changes" empty unless a human-signed file changed.
- [X] T053 Run the whole capability suite once at the end: `scripts/sdd/test-spec.sh libs/domains/seller-insights` (batches if needed; a batch without a summary line is a crash, L-008).

---

## Gap coverage map

A1,A2,A3,A4,A5,A6,A7,A9,A10,A11,A12,A50 → T023–T025 · A8,A15 → T007–T011,T027 · A13 → T044–T045 · A14,A16,A18–A22 → T026–T030 · A17 → T029–T030 · A23–A25 → T031–T033 · A26–A34 → T034–T038 · A35–A44 → T039–T043 · A45,A49 → T019–T022 · A46 → T018,T049 · A47 → T003,T019–T048 · A48 → T004–T006 · A51 → T046 · B D-6 → T013,T028,T043 · D-7,D-12 → T020,T028,T048 · D-8 → T018,T049 · C rows → T025,T028,T048,T050 · D1–D10 → T004–T053.

## Follow-up coverage (planning request)

S03 (no tenancy model/SQL; status gates retested) → T029 (AS-26), T039 · S05 (`catalog.product_*` full state, compacted topic, tombstone) → T021 · S09/S13/S14/S23 (not consumed; recorded) → T052 · S10 (renamed order events, importers in domain, contract factories) → T006, T023, T025, T035, T042 · S11 (`flashsale.*` ignored without DLQ) → T023 (AS-10) · S51 (`topicsWithSubscribers`) → T037 · J01 (`lineTotalMinor` in page; duplicate/invalid tests) → T001, T047.

## Dependencies and order

- Phase 1 → Phase 2 (blocking) → stories. Phase 3 (US7 read models) before US1/US2 (category and names). US1 → US2 → US3 → US4 (snapshots need boards; AS-09/22/28/30 need snapshots, so those scenarios finish after T033). US5 and US6 are independent of US1–US4 after Phase 2 (and share `ShopDirectory` only). Phase 10–11 last.
- Parallel: T004–T006; T007–T009; T015–T016; T019 with T021; T027 with T026; T036; US5 and US6 branches by different people; T044, T046, T047, T049, T051, T052.

## Implementation strategy

MVP = Phase 1–2 + US7 (read models) + US1 (board feed) + US2 (top list). Then US3, US4, US5, US6, observability and gates. Unverified criteria: SC-002, SC-003, SC-005 remain "not run" (T002).
