# Test Plan: S26 — Follow graph and home feed (domain `community`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (51 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. A unit entry proves the pure rule table; the API e2e entry of the same row proves one wired case through the real stack, never the table again.

- API e2e files live in `packages/backend/libs/domains/community/` and boot the real `FeedModule` (HTTP), the feed worker module (consumers, relay, reconciliation job) and the identity and tenancy modules they import, with the production global prefix, `ValidationPipe`, problem+json filter and interceptors, called through `supertest`, against real ScyllaDB (CQL migrations applied), Redis and Kafka stand-ins from `docker-compose.test.yaml`. Each file's top-level `describe` names its feature (VII.8). The existing `feed.e2e-spec.ts` calls services directly: it is replaced by the files below, which call HTTP and deliver events through the real consumers.
  - `follow-graph.e2e-spec.ts` — describe "Follow graph: follow, unfollow, limits and privacy"
  - `feed-items.e2e-spec.ts` — describe "Follow feed: items from events, idempotency and out-of-order delivery"
  - `feed-read.e2e-spec.ts` — describe "Follow feed: home timeline, paging, hydration and degradation"
  - `feed-celebrity.e2e-spec.ts` — describe "Follow feed: celebrity accounts merged at read time"
  - `feed-rebuild.e2e-spec.ts` — describe "Follow feed: inactive users and rebuild on return"
  - `feed-fanout.e2e-spec.ts` — describe "Follow feed: fan-out, backpressure, recovery and operations"
- Users, shops and products are seeded only through the shared fixture helpers, the identity fixture (`SessionIssuer`) and the exported services or events of identity, tenancy and catalog; no spec injects `UserModel`, `ShopModel` or `ProductModel` (D-7). Source events (S05, S21, S25) are delivered through the real consumers with contract-valid envelopes from fixtures. The clock is frozen and advanced explicitly (active window, retention, 24-hour price-drop rule).
- Only system edges are faked: identity token verification, the event bus (a spy plus a switchable failure and pause/resume spy), S25's `getPostsByIds` and S03's `getShopsByIds` where a failure must be forced (switchable wrappers at the exported-service edge, never stubbing community's own services), and the clock. Faults for the in-memory timeline store and the durable store are injected through switchable wrappers at the driver edge. The same edge wrappers count reads and writes per call (AS-40, AS-44, AS-37). Configuration overrides: celebrity threshold 3, pushed-timeline window 5, follower page size 2, following limit 3, rebuild concurrency 16, scan bound 5 × limit.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `merge.spec.ts` (k-way merge, `fast-check` property: output equals the sorted, de-duplicated union cut at limit and cursor), `cursor.spec.ts` (opaque keyset cursors, tamper detection), `item-rules.spec.ts` (event → item mapping and the price-drop rule table), `version-guard.spec.ts` (product copy version and deletion-before-creation rules). Controllers, repositories and glue get no unit tests.
- UI journey (Playwright): no web capability owns the home-feed page or the follow button today (see `questions.md`). The only UI coverage is the cross-domain journey **J05 engagement-loop** (`specs/journeys`): a buyer follows a shop, the shop's new product appears in the feed. Rows marked "J05" are the only UI coverage S26 asks for; edge cases are never re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (no community finding); `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback and degradation tests that force the fault: AS-30 (one celebrity read fails), AS-37 (history read fails), AS-41 (S25 and S03 lookups fail), AS-42 (timeline store down, durable store down), AS-45 (store saturation pauses the consumer), AS-46 (fan-out fails part-way), AS-48 (bus down at storing time), AS-28 and AS-33 (in-memory state wiped).
- Concurrency tests use `Promise.all` and assert the allowed outcome and the invariant, repeated at least 20 times in one test: AS-03, AS-06, AS-07, AS-15 (20 deliveries), AS-27, AS-34 (10 reads), AS-35.
- Rate-limit tests (VII.3) freeze the clock: AS-09.
- Async consumers (VII.4): each consumer gets a double-delivery test and an invalid-payload test. Product projector and discussion/auction projector: AS-15, AS-16. Fan-out consumer: AS-22. The announcement relay: AS-48.
- Every e2e response is parsed with the matching `packages/contracts` schema (VII.6) and every test asserts the response body and the persisted state (follow rows in both directions, counts, item rows, product copies, timeline and celebrity keys with their TTLs, recorded announcements) (VII.2).
- The k6 script `scripts/load-tests/feed.test.js` (`pnpm loadtest:feed`: timeline reads at 1/2/4 instances; fan-out lag for a 10,000-follower author) proves SC-001 and SC-004. It is an ops artifact, not part of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 follow a shop (both directions, count, status) | `follow-graph.e2e-spec.ts` | J05 (follow a shop) | — |
| AS-02 follow replay | `follow-graph.e2e-spec.ts` | — | — |
| AS-03 20 concurrent identical follows | `follow-graph.e2e-spec.ts` | — | — |
| AS-04 follow validation (malformed, unknown, deleted, self) | `follow-graph.e2e-spec.ts` (one case per failure class) | — | — |
| AS-05 unfollow, replay, missing account, count never negative | `follow-graph.e2e-spec.ts` | — | — |
| AS-06 follow racing unfollow, sides agree | `follow-graph.e2e-spec.ts` | — | — |
| AS-07 following limit, re-follow at limit, race at the edge | `follow-graph.e2e-spec.ts` | — | — |
| AS-08 unauthenticated → 401 (every route) | `follow-graph.e2e-spec.ts` | — | — |
| AS-09 rate limits → 429 and fail modes | `follow-graph.e2e-spec.ts` | — | — |
| AS-10 other user's data unreachable (IDOR) | `follow-graph.e2e-spec.ts` | — | — |
| AS-11 following list paging and validation | `follow-graph.e2e-spec.ts` | — | `cursor.spec.ts` (encode, decode, tamper) |
| AS-12 follow-status batch | `follow-graph.e2e-spec.ts` | — | — |
| AS-13 new product reaches an active follower's feed (shape, announcement) | `feed-items.e2e-spec.ts` | J05 (product appears in feed) | — |
| AS-14 event → item mapping, non-qualifying events, 24-hour price-drop rule | `feed-items.e2e-spec.ts` (one wired case per kind) | — | `item-rules.spec.ts` (mapping and price-drop table) |
| AS-15 duplicate and concurrent source events create one item | `feed-items.e2e-spec.ts` | — | — |
| AS-16 invalid payloads dead-lettered, no side effects | `feed-items.e2e-spec.ts` (each consumer) | — | — |
| AS-17 out-of-order source events, retry of missing product copy | `feed-items.e2e-spec.ts` | — | `version-guard.spec.ts` (version and deletion-first table) |
| AS-18 pushes arriving out of order, ties by `itemId` | `feed-read.e2e-spec.ts` | — | `merge.spec.ts` (tie rule) |
| AS-19 cursor paging without gaps or repeats, past the pushed window | `feed-read.e2e-spec.ts` | — | `cursor.spec.ts` (position round-trip) |
| AS-20 feed validation (limit, unknown parameter, cursor) | `feed-read.e2e-spec.ts` | — | — |
| AS-21 empty feed | `feed-read.e2e-spec.ts` | — | — |
| AS-22 `feed.item_published` duplicate delivery and invalid payload | `feed-fanout.e2e-spec.ts` | — | — |
| AS-23 retention: items older than 90 days not served | `feed-read.e2e-spec.ts` | — | — |
| AS-24 celebrity: zero pushes, every follower sees the item once | `feed-celebrity.e2e-spec.ts` | — | — |
| AS-25 normal author: push to active only | `feed-celebrity.e2e-spec.ts` | — | — |
| AS-26 merge of pushed timeline and several celebrities, dedupe | `feed-celebrity.e2e-spec.ts` (one wired case) | — | `merge.spec.ts` (merge tables, property test) |
| AS-27 promotion to celebrity racing a publish | `feed-celebrity.e2e-spec.ts` | — | — |
| AS-28 celebrity status and recents survive loss of in-memory state | `feed-celebrity.e2e-spec.ts` | — | — |
| AS-29 celebrity status is sticky | `feed-celebrity.e2e-spec.ts` | — | — |
| AS-30 one celebrity read times out → partial feed, degraded | `feed-celebrity.e2e-spec.ts` | — | — |
| AS-31 pure k-way merge rules | — | — | `merge.spec.ts` (empty, single, ties, duplicates, cursor, limit, 50 lists) |
| AS-32 inactive user: no pushes, rebuild on return, becomes active | `feed-rebuild.e2e-spec.ts` | — | — |
| AS-33 pushed timeline lost for an active user → rebuild | `feed-rebuild.e2e-spec.ts` | — | — |
| AS-34 10 concurrent first reads identical, no duplicates | `feed-rebuild.e2e-spec.ts` | — | — |
| AS-35 push during rebuild neither lost nor duplicated | `feed-rebuild.e2e-spec.ts` | — | — |
| AS-36 follow shows recent items, unfollow hides, re-follow shows | `feed-rebuild.e2e-spec.ts` | — | — |
| AS-37 rebuild concurrency bound, per-call timeout, retry on next read | `feed-rebuild.e2e-spec.ts` | — | — |
| AS-38 post deleted, product archived/restored/deleted, shop suspended/deleted hide items | `feed-read.e2e-spec.ts` | — | — |
| AS-39 page fill from further candidates, scan bound | `feed-read.e2e-spec.ts` | — | — |
| AS-40 batched hydration, parallel sources | `feed-read.e2e-spec.ts` | — | — |
| AS-41 hydration source failure (S25, S03) → omitted, degraded, no leak | `feed-read.e2e-spec.ts` | — | — |
| AS-42 timeline store down → pull; durable store down → 503 | `feed-read.e2e-spec.ts` | — | — |
| AS-43 item and page shapes per kind, integer money | `feed-read.e2e-spec.ts` (contract parse of every kind) | — | — |
| AS-44 follower paging, pipelined batched writes | `feed-fanout.e2e-spec.ts` | — | — |
| AS-45 backpressure: pause, resume, nothing lost | `feed-fanout.e2e-spec.ts` | — | — |
| AS-46 fan-out failure part-way, redelivery, exactly once | `feed-fanout.e2e-spec.ts` | — | — |
| AS-47 per-author order | `feed-fanout.e2e-spec.ts` | — | — |
| AS-48 bus down at storing time, announced after recovery | `feed-fanout.e2e-spec.ts` | — | — |
| AS-49 every in-memory key has an expiry, active marker slides | `feed-fanout.e2e-spec.ts` | — | — |
| AS-50 structured log line and metrics | `feed-fanout.e2e-spec.ts` | — | — |
| AS-51 reconciliation of counts and half-written relations | `follow-graph.e2e-spec.ts` | — | — |

Pattern coverage: P0101 (bounded concurrency, `allSettled` partial responses) → AS-30, AS-37, AS-40, AS-41; P0609 (consumer backpressure) → AS-44, AS-45, AS-46; P1112 (k-way merge by ID) → AS-26, AS-31.
