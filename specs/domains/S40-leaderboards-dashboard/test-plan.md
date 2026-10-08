# Test Plan: S40 — Seller Leaderboards, Live Sales Dashboard, Seller Stats (domain `seller-insights`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (62 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/seller-insights/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `LeaderboardsModule`, `SellerStatsModule`, `LeaderboardsWorkerModule` and the projector module of the domain with the production prefix, `ValidationPipe`, problem+json filter and interceptors, through `supertest`, against real Postgres, Redis, Kafka stand-in and ClickHouse with real migrations (`docker-compose.test.yaml`). Time is frozen at `T0 = 2026-10-06T12:00:00Z`.
  - `leaderboard-feed.e2e-spec.ts` — describe "Leaderboards: board feed (idempotency, ties, periods, replay, limits)"
  - `leaderboard-read.e2e-spec.ts` — describe "Leaderboards: public top list and my rank"
  - `leaderboard-snapshots.e2e-spec.ts` — describe "Leaderboards: period snapshots"
  - `dashboard-live.e2e-spec.ts` — describe "Live dashboard: counters, ticker and frames"
  - `dashboard-history.e2e-spec.ts` — describe "Live dashboard: today chart and analytics availability"
  - `seller-stats.e2e-spec.ts` — describe "Seller stats: summary, refunds, windows and isolation"
  - `read-models.e2e-spec.ts` — describe "Seller insights: shop and product read models, shop deletion"
  - `observability.e2e-spec.ts` — describe "Seller insights: metrics and logs"
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): `periods.spec.ts` (AS-07), `ranking-key.spec.ts` (AS-14, with `fast-check` for the order property), `rank-percent.spec.ts` (AS-29), `conversion.spec.ts` (AS-40), `average-order-value.spec.ts` (AS-56). Controllers, repositories, jobs and projectors get no unit tests.
- Fixtures: shops, products, memberships and orders are created only through the shared fixture helpers and the exported services of tenancy and catalog (no spec injects `ProductModel`, `ShopModel` or `ShopMembershipModel`, D-7); paid, reserved, refunded and product/shop events are built with the event factories of `packages/contracts` and handed to the real projector modules (and, for the end-to-end route, through the Kafka stand-in). Every test asserts the response body **and** the persisted state (board contents and key expiry, snapshot rows, counters, analytics rows, read-model rows, dead letters, metrics).
- Only system edges are faked: identity token verification, the clock, and fault injection on a store (VII.9). Redis and ClickHouse are real.
- Consumers have the duplicate-delivery and invalid-payload tests of VII.4: every paid-order consumer (board feed, live counters, sales history) runs AS-02/AS-41/AS-55 (duplicates) and AS-10 (invalid payloads); the shop and product read-model consumers run AS-58 and AS-59; the refund consumer runs AS-53.
- UI journey (Playwright): owned by W04, `packages/web/e2e/seller-dashboard.spec.ts` — one happy path: a seller opens the dashboard of their shop, a paid order arrives, the live panel updates within 2 seconds, today's chart and the "my rank" card show the sale, the stats page shows the figures. It never repeats an edge case from this plan. The public leaderboard page has no web capability yet; its journey is added by whichever web capability owns that page.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-62).
- Gate 9 (VII.9): AS-21 (limiter store down), AS-23 (board store down), AS-41 (fault while applying), AS-44 (slow tick), AS-48 (analytics store down), AS-49 (shutdown) each force their fault.
- Concurrency tests use `Promise.all` and assert the invariant (VII.3): AS-02, AS-03, AS-33, AS-41, AS-43, AS-55.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 paid order lands on every board | `leaderboard-feed.e2e-spec.ts`: `O1` through the board feed; overall/`electronics`/`accessories` for week and month, `2026-W40`/`2026-09` empty, `lineTotalMinor` used, counter `applied` 2 | — | — |
| AS-02 duplicate delivery | `leaderboard-feed.e2e-spec.ts`: redelivery once, twice at once, ten at once; figures unchanged, `duplicate` 26, no failure | — | — |
| AS-03 concurrent orders of one shop | `leaderboard-feed.e2e-spec.ts`: 50 orders × 10 parallel workers, `A = 5000` exactly, one entry per board | — | — |
| AS-04 tie: first to reach wins | `leaderboard-feed.e2e-spec.ts`: three phases `[A,B]`, `[B,A]`, `[B,A]` read through the top list | — | — |
| AS-05 out-of-order keeps the last-sale instant | `leaderboard-feed.e2e-spec.ts`: both delivery orders on fresh weeks give identical boards `[B, A]` | — | — |
| AS-06 tie on the same ranking unit | `leaderboard-feed.e2e-spec.ts`: week `[A,C,B]`, month `[C,B,A]`, ten repeated reads on both endpoints | — | — |
| AS-07 UTC week and month assignment | — | — | `periods.spec.ts`: `it.each` over the eight instants (ids, start, exclusive end, offset input) |
| AS-08 late event for a closed unfrozen period | `leaderboard-feed.e2e-spec.ts`: `paidAt 2026-10-04T10:00Z` counts on `2026-W40` and month `2026-10`, not on `2026-W41` | — | — |
| AS-09 event for a frozen period not applied | `leaderboard-snapshots.e2e-spec.ts`: freeze `2026-W40`, deliver the late order; week unchanged, month `+500`, counters `sealed` 1 and `applied` 1, one warning log | — | — |
| AS-10 invalid and unsupported payloads | `leaderboard-feed.e2e-spec.ts`: each of the seven bad messages dead-lettered with a reason and no board change, next valid message applied, foreign type ignored; the same batch runs through the live and history consumers | — | — |
| AS-11 categories from the read model | `leaderboard-feed.e2e-spec.ts`: `P3` unknown, then `phones` v1, `gadgets` v2, stale v1; `category_unresolved` 1, no retro-attribution | — | — |
| AS-12 rebuild by replay | `leaderboard-feed.e2e-spec.ts`: 200 events, record, empty store, replay shuffled twice, byte-equal boards | — | — |
| AS-13 all boards of an order, or none | `leaderboard-feed.e2e-spec.ts`: seed `A` at `8,589,934,000`, two-category order refused whole, no board changed, dead letter `revenue_limit_exceeded` | — | — |
| AS-14 ranking key arithmetic | — | — | `ranking-key.spec.ts`: table (equal revenue earlier/later/same unit, `0`, `2^33 − 1`, period start, `end − 1 unit`, after end, `≥ 2^33` refused, exact revenue recovery) plus `fast-check` order property |
| AS-15 zero-revenue orders | `leaderboard-feed.e2e-spec.ts`: fully discounted order adds no entry, later order of `1` adds the shop with `1` | — | — |
| AS-16 retention | `leaderboard-feed.e2e-spec.ts`: every key of `2026-W41`, `2026-10` and `2026-W40` has an expiry of period end + 35 days ± 1 s, none without | — | — |
| AS-17 top list | `leaderboard-read.e2e-spec.ts`: anonymous call, schema-parsed body, ranks 1..3, no revenue or extra field, `Cache-Control` | W04 journey is not involved; public page journey pending (no owner) | — |
| AS-18 selectors | `leaderboard-read.e2e-spec.ts`: `category=Accessories`, `period=month`, `id=2026-W40`, `limit=1`, empty valid category, default 20 / max 100 | — | — |
| AS-19 validation | `leaderboard-read.e2e-spec.ts`: every invalid class `400` with field error, `2026-W50` `422 period_in_future`, problem+json fields | — | — |
| AS-20 shop names from the read model | `leaderboard-read.e2e-spec.ts`: rename v2, stale v1 ignored, missing row `name: null, slug: null` still ranked | — | — |
| AS-21 rate limit | `leaderboard-read.e2e-spec.ts`: 61st request `429` with `Retry-After`, other address `200`, limiter store down serves and counts `rate_limit_degraded` | — | — |
| AS-22 frozen period from the snapshot | `leaderboard-read.e2e-spec.ts`: freeze, delete the live board, `source: "snapshot"`, `closed: true`, long cache header, later live change not visible | — | — |
| AS-23 board store down | `leaderboard-read.e2e-spec.ts`: store unreachable: current week `503` with `Retry-After: 5` within 1 s and a generic detail; frozen week `200` | — | — |
| AS-24 my rank | `leaderboard-read.e2e-spec.ts`: member (and viewer) of `A`, `rank 2 / of 3 / topPercent 67 / revenueMinor 10000`, category variant, schema-parsed | W04 journey step "my rank card shows the shop's rank" | — |
| AS-25 not ranked | `leaderboard-read.e2e-spec.ts`: shop without sales, category without sales, period without sales: `404 not_ranked` | — | — |
| AS-26 tenant isolation and access | `leaderboard-read.e2e-spec.ts`: stranger, unknown id, malformed id give byte-identical `404 shop_not_found`; `401`; suspended `200`; deleted `404` | — | — |
| AS-27 rank agrees with the top list | `leaderboard-read.e2e-spec.ts`: 25 shops with three tied; every `rank` equals list position, `of` 25 | — | — |
| AS-28 rank in a frozen period | `leaderboard-read.e2e-spec.ts`: 101 shops frozen; position 100 `200 rank 100 / of 101 / topPercent 100`, position 101 `404 not_ranked` | — | — |
| AS-29 percentile | — | — | `rank-percent.spec.ts`: `it.each` over the six pairs |
| AS-30 rank of a closed unfrozen period | `leaderboard-read.e2e-spec.ts`: `2026-W40` before the freeze answered from the live board; after the freeze the same call answers from the snapshot | — | — |
| AS-31 snapshot after close | `leaderboard-snapshots.e2e-spec.ts`: clock `2026-10-05T01:00Z`, three boards, top 100 rows with name, revenue, `participants 101`, job result; month `2026-09` at `2026-10-01T01:00Z` | — | — |
| AS-32 period not closed refused | `leaderboard-snapshots.e2e-spec.ts`: `00:59:59`, current, future, malformed: `period_not_closed` / `invalid_period`, no rows, existing snapshot untouched | — | — |
| AS-33 re-run, concurrent run, readers | `leaderboard-snapshots.e2e-spec.ts`: re-run, two at once, polling reader never sees empty or partial; ranks `1..n` | — | — |
| AS-34 catch-up | `leaderboard-snapshots.e2e-spec.ts`: two unfrozen closed weeks frozen oldest first; a period with no boards skipped with one warning | — | — |
| AS-35 registration | `leaderboard-snapshots.e2e-spec.ts`: three boots leave two schedules with the cron expressions; two replicas fire, one run | — | — |
| AS-36 snapshot is a historical record | `leaderboard-snapshots.e2e-spec.ts`: rename after freeze, list unchanged; unknown name stored `null` | — | — |
| AS-37 frame content | `dashboard-live.e2e-spec.ts`: four reservations and one paid order at second `T`; frame equals the stated JSON, parsed by the contracts schema | W04 journey step "live panel updates within 2 s of the sale" | — |
| AS-38 several shops in one order | `dashboard-live.e2e-spec.ts`: `S1`/`S2` counters, duplicated shop id in `shopIds` counts once | — | — |
| AS-39 window edges | `dashboard-live.e2e-spec.ts`: `T−59`, `T`, `T−60`, `T+2`, stale event: counters and `stale` 1; history still receives the sale | — | — |
| AS-40 conversion | — | — | `conversion.spec.ts`: `it.each` over the six pairs |
| AS-41 counters exactly-once and crash-safe | `dashboard-live.e2e-spec.ts`: redelivery once and ten at once leave counters unchanged; injected store failure on the first attempt, redelivery counted once | — | — |
| AS-42 a frame every second, only where watched | `dashboard-live.e2e-spec.ts`: subscriber through the real gateway gets one frame per second for three seconds incl. an empty one, decays to zeros; no subscriber, no frame computed; reconnect gets no replay | W04 journey (same step as AS-37) | — |
| AS-43 one publisher per shop, failover | `dashboard-live.e2e-spec.ts`: two ticker instances, same second, one frame; stop the holder, other publishes within 5 s | — | — |
| AS-44 a slow tick never piles up | `dashboard-live.e2e-spec.ts`: forced slow tick, next tick skipped, `ticks_skipped` 1, no overlap, next frame correct | — | — |
| AS-45 frames stay inside their shop | `dashboard-live.e2e-spec.ts`: two shops, two subscribers, frames never cross; non-member subscription refused | — | — |
| AS-46 today chart | `dashboard-history.e2e-spec.ts`: four orders, UTC day, sparse minutes, totals; redelivery and a two-batch order leave numbers unchanged; schema-parsed | W04 journey step "today's chart shows the sale" | — |
| AS-47 access to the dashboard routes | `dashboard-history.e2e-spec.ts`: stranger/unknown/malformed `404` identical, `401`, viewer/staff/suspended `200`, no cross-shop data | — | — |
| AS-48 analytics store down | `dashboard-history.e2e-spec.ts`: store unreachable and 3 s timeout on "today" and stats: `503` with `Retry-After`, generic detail within 4 s; live frames keep flowing | — | — |
| AS-49 graceful shutdown | `dashboard-live.e2e-spec.ts`: shutdown during a tick, tick finishes, no later frame, leases released, other instance takes over | — | — |
| AS-50 stats | `seller-stats.e2e-spec.ts`: the stated orders and refund, exact summary, zero-filled seven days, top products, schema-parsed, no buyer identity | W04 journey step "stats page shows revenue and orders" | — |
| AS-51 stats validation | `seller-stats.e2e-spec.ts`: every invalid `days` class `400`, default 30, `1` and `365` accepted | — | — |
| AS-52 stats access and isolation | `seller-stats.e2e-spec.ts`: stranger `404` identical to unknown, `401`, viewer `200`, shops never mixed | — | — |
| AS-53 refunds | `seller-stats.e2e-spec.ts`: two-shop refund split `3000`/`2000`, refund day, duplicate and concurrent delivery once, no sale retried then dead-lettered after 5, partial amount dead-lettered, boards and frames unchanged | — | — |
| AS-54 shop without sales | `seller-stats.e2e-spec.ts`: zeros, three zero days, empty `topProducts` | — | — |
| AS-55 every sale counted once, rebuildable | `seller-stats.e2e-spec.ts`: three deliveries, one after forced compaction, concurrent; then empty the store and replay shuffled: stats and "today" identical | — | — |
| AS-56 average order value | — | — | `average-order-value.spec.ts`: `it.each` over the five pairs |
| AS-57 window boundaries | `seller-stats.e2e-spec.ts`: orders at `2026-10-05T23:59:59Z`, `2026-10-06T00:00:00Z`, `2026-10-04T23:59:59Z` against `days` 1, 2, 3 | — | — |
| AS-58 shop read model consumer | `read-models.e2e-spec.ts`: delivery order 2, 1, 1 holds `Alpha Plus` v2; invalid messages dead-lettered with no effect | — | — |
| AS-59 product read model consumer | `read-models.e2e-spec.ts`: order 3, 1, 2, 3 holds `tablets` v3; `deleted` keeps the category; invalid message dead-lettered | — | — |
| AS-60 a deleted shop leaves every store | `read-models.e2e-spec.ts`: shop on live boards, snapshot rank 1 of 3, counters, analytics, read models; after `shop_deleted` everything gone, snapshot renumbered `1..2`, stats/today `404`, repeat delivery no change | — | — |
| AS-61 observability | `observability.e2e-spec.ts`: counters per outcome after replaying the scenarios' inputs, lag gauge present, log lines structured with `requestId`/`traceId` and no buyer id or payload | — | — |
| AS-62 data ownership (static) | CI gates: `check:table-ownership --strict` shows zero `seller-insights` findings, `check:boundaries`, barrel export test of the entry point | — | — |
