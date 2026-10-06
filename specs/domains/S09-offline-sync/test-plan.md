# Test Plan: S09 — Offline-First Inventory Sync (domain `catalog-sync`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (55 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/catalog-sync/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `OfflineSyncModule`, `OfflineSyncWorkerModule` and `OfflineSyncProjectorModule` (consumers and jobs invoked through their real handlers) together with the tenancy, identity, **catalog** (S05), outbox and rate-limiter modules, with the production pipe, filter, prefix and interceptors, through `supertest`, against real engines with real migrations (VII.2).
  - `sync-push.e2e-spec.ts` — describe "Offline sync: push, operation idempotency and stock deltas"
  - `sync-fields.e2e-spec.ts` — describe "Offline sync: per-field last-writer-wins"
  - `sync-pull.e2e-spec.ts` — describe "Offline sync: pull and change feed" (HTTP)
  - `sync-feed-consumer.e2e-spec.ts` — describe "Offline sync: change feed consumers" (VII.4 duplicate and invalid-payload tests)
  - `sync-conflicts.e2e-spec.ts` — describe "Offline sync: conflict review"
  - `sync-access.e2e-spec.ts` — describe "Offline sync: access, tenancy and limits"
  - `sync-lifecycle.e2e-spec.ts` — describe "Offline sync: lifecycle jobs and observability"
- Products are read and changed in tests only through `@app/domains/catalog` exported services (`ProductQueryService`, `ProductStockService`, `ProductCommandService`) or the shared fixture helpers; no spec injects `ProductModel` or `ShopModel` (D-7). Every test asserts the response body **and** the persisted state (operation rows, feed rows, clocks, conflicts, outbox rows, catalog product state) (VII.2).
- Only system edges are faked: identity token verification and the clock (frozen and advanced by the test). Faults use real mechanisms: a store rule that refuses one write of an operation's result (AS-13, AS-38), a store delay that exhausts the push budget (AS-37).
- Consumers (`catalog.product_*` events, `tenancy.shop_deleted`, `catalog.product_deleted`) each have the duplicate-delivery and invalid-payload tests of VII.4 (AS-27, AS-28, AS-48, AS-49).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): hybrid logical clock encode/decode/tick/receive and plausibility (`hlc.spec.ts`), delta arithmetic and the per-field decision and tie rule (`merge.spec.ts`, with `fast-check` for convergence), operation schema validation (`ops.spec.ts`), cursor encode/decode and generation binding (`cursor.spec.ts`), result classification and clamping arithmetic (`outcome.spec.ts`). No unit tests for controllers, repositories or glue.
- UI journey (Playwright): none. The device application is phase 2 and the dashboard's conflict screen belongs to W04; when they exist their happy path is listed in their own plans, and J04 reads the HTTP routes and events only. Every UI cell below is therefore `—`.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-53).
- Contract layer (VII.6): every e2e parses responses with `syncPushResponseSchema`, `syncPullResponseSchema`, `syncConflictSchema`, `syncConflictPageSchema` and outbox payloads with `syncEventSchemas`.
- Gate 9 (VII.9): AS-13, AS-14, AS-37 and AS-38 are degradation or recovery paths and each forces its fault.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 deltas commute (two devices, both orders) | `sync-push.e2e-spec.ts`: +3 and −1 in both orders → 12, versions, one catalog event per op, none written by this domain | — | — |
| AS-02 replay | `sync-push.e2e-spec.ts`: ten replays → `replayed: true`, original `quantityAfter`, no new row or event | — | — |
| AS-03 concurrent replay | `sync-push.e2e-spec.ts`: `Promise.all` same batch → one effect, one `replayed: false` | — | — |
| AS-04 same ID, different content | `sync-push.e2e-spec.ts`: `op_id_reused`, stored op, quantity and events unchanged | — | — |
| AS-05 IDs scoped to the shop | `sync-push.e2e-spec.ts`: shop B reuses A's ID → applied, A untouched | — | — |
| AS-06 count becomes a delta | `sync-push.e2e-spec.ts`: `counted 8, base 10`, quantity 9 → 7, `delta: -2` | — | — |
| AS-07 count confirms | `sync-push.e2e-spec.ts`: zero delta, no catalog call, no event, record replayable | — | — |
| AS-08 oversold last unit | `sync-push.e2e-spec.ts`: concurrent two sells → one `applied`, one `conflict`, quantity 0, one open conflict, one outbox event | — | — |
| AS-09 partly oversold | `sync-push.e2e-spec.ts`: clamp numbers `requested -3, applied -1, shortfall 2` | — | clamping arithmetic in `outcome.spec.ts` (table) |
| AS-10 over the quantity limit | `sync-push.e2e-spec.ts`: `quantity_limit` conflict, unchanged quantity | — | — |
| AS-11 unknown or foreign product | `sync-push.e2e-spec.ts`: identical `unknown_product` bodies, nothing written in either shop | — | — |
| AS-12 archived product | `sync-push.e2e-spec.ts`: `product_unavailable` for stock and field operations | — | — |
| AS-13 crash between applying and recording | `sync-push.e2e-spec.ts`: store rule refuses the result write once → `503`, +61 s, repeat → one effect, one event | — | — |
| AS-14 in flight, takeover, recovery job | `sync-push.e2e-spec.ts`: 45 s → `in_flight`; 61 s → takeover once; recovery job twice and on two instances → once | — | — |
| AS-15 both field edits survive | `sync-fields.e2e-spec.ts`: title and price, both orders, per-field clocks stored | — | — |
| AS-16 stale edit loses its field only | `sync-fields.e2e-spec.ts`: `merged`, no event, mixed edit applies only the new field | — | — |
| AS-17 ties break deterministically | — | — | `merge.spec.ts`: same physical/counter, nodes `dev-a`/`dev-b`, both orders; equal clock loses |
| AS-18 concurrent edits of one field | `sync-fields.e2e-spec.ts`: `Promise.all` ×20 random order → greater clock wins | — | — |
| AS-19 implausible clock on an edit | `sync-fields.e2e-spec.ts`: +61 s edit `clock_implausible`, unchanged clocks; stock op with same skew applies | — | plausibility boundary 60 s / 60.001 s in `hlc.spec.ts` |
| AS-20 invalid clock, node mismatch | `sync-fields.e2e-spec.ts`: `invalid_hlc`, `hlc_node_mismatch`, nothing applied | — | decode table in `hlc.spec.ts` |
| AS-21 too old | `sync-fields.e2e-spec.ts`: 30 d + 1 s → `op_expired` | — | — |
| AS-22 field values refused | `sync-fields.e2e-spec.ts`: `invalid_op` paths, `invalid_field` from the catalog, valid ops of the batch applied, no clock advanced | — | schema table in `ops.spec.ts` |
| AS-23 server time authority | `sync-fields.e2e-spec.ts`: `serverHlc` above accepted clocks, monotonic per instance | — | receive rule in `hlc.spec.ts` |
| AS-24 everything after the cursor, in order | `sync-pull.e2e-spec.ts`: online order, dashboard edit, push → three entries, consecutive `seq`, empty second pull | — | — |
| AS-25 paging | `sync-pull.e2e-spec.ts`: 5 changes, `limit=2` → 2/2/1, `hasMore`, no gap or repeat | — | — |
| AS-26 no holes under concurrent writers | `sync-feed-consumer.e2e-spec.ts`: 30 concurrent events → `seq` 1…30, repeated pulls miss nothing | — | — |
| AS-27 duplicate and out-of-order events | `sync-feed-consumer.e2e-spec.ts`: version 7 twice → one entry; version 6 after 7 → ignored | — | — |
| AS-28 invalid event | `sync-feed-consumer.e2e-spec.ts`: each bad payload dead-lettered, feed unchanged, next event processed | — | — |
| AS-29 archive, restore, delete | `sync-feed-consumer.e2e-spec.ts`: statuses and tombstone in order | — | — |
| AS-30 own changes come back as no-ops | `sync-pull.e2e-spec.ts`: push result `productVersion` equals the pulled entry's `version` | — | — |
| AS-31 cursor and limit validation | `sync-pull.e2e-spec.ts`: malformed, foreign-shop cursor, limits `0`, `501`, `abc` → `400`, no fallback | — | cursor decode table in `cursor.spec.ts` |
| AS-32 resync required | `sync-pull.e2e-spec.ts`: old generation, ahead of head, past horizon → `410`; pull without cursor returns full state | — | — |
| AS-33 per-operation outcomes | `sync-push.e2e-spec.ts`: three ops, middle invalid → `applied`, `invalid_op`, `applied` | — | — |
| AS-34 duplicates inside a batch | `sync-push.e2e-spec.ts`: same op twice → `replayed: true`; different content → `op_id_reused` | — | — |
| AS-35 envelope validation | `sync-access.e2e-spec.ts`: every envelope class `400`, body over 2 MiB `413`, nothing applied | — | — |
| AS-36 rate limit | `sync-access.e2e-spec.ts`: push and pull `429` with `Retry-After`; nothing applied; applies after window | — | — |
| AS-37 time budget | `sync-push.e2e-spec.ts`: slow store, 120 results + 380 `deadline_exceeded`, resend completes once | — | — |
| AS-38 store failure mid-batch | `sync-push.e2e-spec.ts`: `503 sync_unavailable` with generic detail, earlier ops durable, resend replays | — | — |
| AS-39 list and paging | `sync-conflicts.e2e-spec.ts`: 3 open + 2 dismissed, `limit=2`, `status`, invalid params `400` | — | — |
| AS-40 dismiss | `sync-conflicts.e2e-spec.ts`: `200`, second `409 conflict_not_open`, concurrent → one `200` one `409` | — | — |
| AS-41 conflict access | `sync-conflicts.e2e-spec.ts`: other shop's ID `404`; viewer list ok, dismiss `403` | — | — |
| AS-42 unauthenticated | `sync-access.e2e-spec.ts`: all four routes `401`, nothing applied | — | — |
| AS-43 roles | `sync-access.e2e-spec.ts`: one user per role × four routes against the matrix | — | — |
| AS-44 cross-tenant (IDOR) | `sync-access.e2e-spec.ts`: shop A member on `/shops/B/…` → identical `404`; no B entry in A's pull | — | — |
| AS-45 removed while offline | `sync-access.e2e-spec.ts`: removed member's push `404`, nothing applied | — | — |
| AS-46 shop status | `sync-access.e2e-spec.ts`: `403 shop_suspended`, `409 shop_offboarding`, pull follows the gate | — | — |
| AS-47 identity from session only | `sync-access.e2e-spec.ts`: body `shopId`/`userId`/`deviceId` refused; stored op has path, session, header values | — | — |
| AS-48 shop deleted | `sync-lifecycle.e2e-spec.ts`: delivered twice → rows gone once, other shop untouched; invalid payload dead-lettered | — | — |
| AS-49 product deleted | `sync-lifecycle.e2e-spec.ts`: delivered twice → clocks gone once, operations stay | — | — |
| AS-50 operation retention | `sync-lifecycle.e2e-spec.ts`: 95/85/10-day records and a 120-day open conflict; job twice, two instances | — | — |
| AS-51 observability | `sync-lifecycle.e2e-spec.ts`: log fields and absence of titles/bodies, metrics registry names and values | — | — |
| AS-52 stock writes only through the catalog | `sync-lifecycle.e2e-spec.ts`: events written by the catalog, one stock command per op with the deterministic ID, replay adds none | — | — |
| AS-53 boundaries | static: `check:table-ownership --strict`, `check:boundaries`, migration inspection (no foreign key, no trigger on catalog tables) | — | — |
| AS-54 convergence property | — | — | `merge.spec.ts`: `fast-check` over generated device operations, all orders and duplicates |
| AS-55 feed compaction | `sync-lifecycle.e2e-spec.ts`: frozen clock, job twice and on two instances, final state of a young cursor unchanged | — | — |
