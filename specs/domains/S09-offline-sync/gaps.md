# Gaps: S09 — current `catalog-sync` offline-sync code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05 in `libs/domains/catalog-sync/`. **Check not run:** `pnpm --dir packages/backend check:table-ownership` needs an approval an unattended session cannot get, so section C is reconstructed from searches over this capability's files (`application/sync.service.ts`, `api/sync.controller.ts`, `sync.module.ts`, `sync.e2e-spec.ts`, `migrations/20261001360000-offline-sync.js`, `db/ownership.ts`). Run the real check first and reconcile.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Stock is changed with raw `UPDATE "Product" SET quantity = quantity + :delta, version = version + 1` (owner: catalog); no catalog invariant, no operation ID passed to the catalog | `application/sync.service.ts:84` | FR-012, FR-013, AS-52 |
| A2 | Negative stock is applied and flagged `conflict` (quantity can be −1) | `application/sync.service.ts:90`, `sync.e2e-spec.ts:67` | FR-013, AS-08, AS-09 |
| A3 | Field edits are raw `UPDATE "Product" SET "title" = …` with column names built from the field names (`${sets}`), `price` unit unnamed | `application/sync.service.ts:99-103`, `api/sync.controller.ts:18` | FR-016, FR-020, AS-22 |
| A4 | Product events are raw outbox rows `{productId}` written by this domain (`KafkaTopicGroup.PRODUCTS_EVENTS`), twice per op path | `application/sync.service.ts:88,113` | FR-012, S05 FR-042 (only the catalog emits product events) |
| A5 | Field-clock decision reads `ProductFieldClock … FOR UPDATE`: when no clock row exists the lock covers nothing, so two first edits of one product race and both win | `application/sync.service.ts:93-97` | FR-018, AS-18 |
| A6 | The claim, the product write and the result are one transaction across two owners' tables (also an IX.4 violation); replacing the product write with R1 calls means the claim must be committed first and the catalog call made with a deterministic operation ID | `application/sync.service.ts:63-77` | FR-005, AS-13, AS-14 |
| A7 | Operation key is a global primary key `"opId"` (no shop in the key): shop B can collide with A's operation and learn it exists (`duplicate`); no content fingerprint; a replay returns `duplicate` without the original outcome; no `deviceId` check on the clock's node; no user recorded | `migrations/20261001360000-offline-sync.js` (`SyncOperation`), `application/sync.service.ts:65-69` | FR-003, FR-004, FR-009, AS-04, AS-05, AS-47 |
| A8 | `opId` accepted as any UUID (not UUIDv7) | `api/sync.controller.ts:14-16` | FR-002 |
| A9 | One invalid operation fails the whole push with `400 op N invalid`; envelope and operation errors are mixed; no body size cap; empty `ops` accepted (`body.ops ?? []`) | `api/sync.controller.ts:38-42` | FR-001, FR-007, AS-33, AS-35 |
| A10 | Controller holds validation and parsing logic (zod discriminated union, header regex, loop) → belongs in DTOs/pipes and the application service (II.1); response is not a contract DTO; no `packages/contracts` schemas | `api/sync.controller.ts:11-24,35-45` | FR-001, FR-035, VII.6 |
| A11 | Every operation is rejected when its clock is more than 60 s ahead, including stock deltas; `Date.now()` read directly (no injected clock); rejected operations are not recorded | `application/sync.service.ts:60`, `domain/hlc.ts:36-39` | FR-021, AS-19 |
| A12 | No max operation age, no retention of operation records, no purge job | `application/sync.service.ts` (absent) | FR-009, FR-010, FR-037, AS-21, AS-50 |
| A13 | Server clock is an in-memory field of a singleton (`node: 'server'`, same node on every instance) | `application/sync.service.ts:24,34,61` | FR-022, AS-23 |
| A14 | Whole-push processing has no budget; a store failure mid-batch surfaces as a raw 500; the controller promise chain has no problem mapping for `sync_unavailable` | `application/sync.service.ts:30-36` | FR-008, AS-37, AS-38 |
| A15 | Pull parses `cursor` with `Number(cursor) \|\| 0` (garbage becomes 0), `limit` with `Number(limit) \|\| 500` (0 becomes 500, negative accepted into `Math.min`) | `api/sync.controller.ts:48-49` | FR-027, AS-31 |
| A16 | Feed rows carry no `version`, no `deleted`, no generation; no tombstones, no compaction, no resync (`410`); a cursor ahead of the head is accepted silently | `application/sync.service.ts:38-50`, migration (`ShopChangeLog`, `ShopSyncState`) | FR-023–FR-028, AS-24–AS-32, AS-55 |
| A17 | Feed filled by an `AFTER INSERT OR UPDATE` trigger on the product table that only fires for four columns (a change to `status` or `currency` is invisible) and copies no version semantics for archive/delete | migration (`product_change_log`, trigger `product_change_log_trg`) | FR-024, FR-025, AS-27, AS-29 |
| A18 | Conflict list is a raw query returning `SyncOperation` rows with `result = 'conflict'`, max 200, no status, no pagination, no dismissal, no event | `application/sync.service.ts:52-57`, `api/sync.controller.ts:52-56` | FR-030, FR-031, AS-39–AS-41 |
| A19 | No `catalog_sync.offline_conflict_opened` event; no outbox row for conflicts | `application/sync.service.ts:90` | FR-030, AS-08 |
| A20 | Rate limit uses the unrelated policy `search.query` on push; none on pull and conflicts | `api/sync.controller.ts:33` | FR-034, AS-36 |
| A21 | `X-Device-Id` required on push only, never on pull; the clock's node is not tied to it | `api/sync.controller.ts:36,47` | FR-021, AS-20 |
| A22 | No consumers: nothing handles `tenancy.shop_deleted` or `catalog.product_deleted` (clocks cascade only through the foreign key); no jobs registered | (absent) | FR-036, FR-037, AS-48–AS-50 |
| A23 | `ProductFieldClock` has no `shopId` and a foreign key with `ON DELETE CASCADE` to the product table | migration (`ProductFieldClock`) | FR-036, FR-038 |
| A24 | Existing tests call `SyncService` directly (no HTTP, no supertest, no auth), use real `Date.now()` (no frozen clock), read `ProductModel`, cover 5 cases of the 55 scenarios; no contract parsing, no IDOR, no 401, no rate-limit, no concurrency of one op, no consumer tests | `sync.e2e-spec.ts:11-104` | VII.2–VII.4, VII.6, whole `test-plan.md` |
| A25 | Unit spec covers HLC, delta sum and winning fields only; no tie rule, no convergence property, no cursor or schema tables | `domain/merge.spec.ts` | VII.5, AS-17, AS-54 |
| A26 | `domain/hlc.ts` is pure and matches the spec's encoding; `plausible` has the drift rule in the same module as clock arithmetic (keep, move the threshold to a parameter) | `domain/hlc.ts:36-39` | FR-021 (keep; no change except the parameter) |
| A27 | No logs/metrics per spec; no `requestId` fields of operations, no counters, no lag gauge | `application/sync.service.ts` (absent) | FR-039, AS-51 |
| A28 | `OfflineSyncModule` exports `SyncService`; there is no worker or projector module for this capability | `sync.module.ts:8`, `index.ts` | Provides (modules), X.4 |
| A29 | Layering: `application/sync.service.ts` injects the raw `Sequelize` connection and writes SQL itself (no repository port in `domain/`, no adapter in `infra/`) | `application/sync.service.ts:27` | I.2, D-6 |

## B. Debt-register rows that name `catalog-sync` or S09 (all open ones)

| Row | What applies to S09 | Paid by |
|---|---|---|
| **D-6** (I.2: layering) | `sync.service.ts` is an application service that queries through the raw connection; the ports/adapters split is missing | Repository ports in `domain/` (operations, feed, clocks, conflicts), adapters in `infra/`; the catalog is reached through its exported services (R1) |
| **D-7** (IX.4: foreign model exports) | `sync.e2e-spec.ts` registers `ShopModel` (tenancy) and `ProductModel` (catalog) with `SequelizeModule.forFeature` | Tests use S03's provisioning/fixture helpers and S05's `ProductQueryService`; no model injection (**R1**) |
| **D-8** (X.4: barrels export internals) | `index.ts` exports `StockPushProjector` (S08) and `ImportJobTopicsModule` (S07); for S09 only `OfflineSyncModule` is exported today | Export `OfflineSyncModule`, `OfflineSyncWorkerModule`, `OfflineSyncProjectorModule`; apps import those |
| **D-10** (D2: order export in catalog-sync) | Not S09 (S07 and S12 own it); listed because it shares the folder | S12 |
| **D-12** (IX.4: raw SQL on foreign tables) | `sync.service.ts:84,101` write the catalog's product table; the migration adds a foreign key and a trigger on it | **R1** `applyStockDelta` and `ProductCommandService.update`; feed by **R3** (consume `catalog.product_*`) |
| **D-15** (catalog ↔ discovery) | Does not touch S09 | — |
| D-1, D-2, D-3, D-4, D-5, D-9, D-13 | Resolved; nothing for S09 | — |

## C. `check:table-ownership` lines for this capability (reconstructed)

| Kind | Where | What | IX.7 mechanism that replaces it |
|---|---|---|---|
| SQL | `application/sync.service.ts:84` | `UPDATE "Product" SET quantity = quantity + …` (owner: catalog) | **R1** `ProductStockService.applyStockDelta` |
| SQL | `application/sync.service.ts:101` | `UPDATE "Product" SET …` field edit (owner: catalog) | **R1** `ProductCommandService.update` (expected version) |
| SQL | `application/sync.service.ts:88,113` | outbox rows on `products.events` for a product this domain does not own (via `OutboxService.notify`) | none: the catalog publishes its own events; this domain publishes only `catalog_sync.offline_conflict_opened` through `outbox.append` (IX.6) |
| SQL | `application/sync.service.ts:93` | read of `ProductFieldClock` (own table, allowed) joined by product ID only | stays; add `shopId` to the table and the predicate (III.4) |
| FK | `migrations/20261001360000-offline-sync.js` (`ProductFieldClock.productId REFERENCES "Product" ON DELETE CASCADE`) | foreign key to another owner's table | drop (expand/contract with `lock_timeout`); plain ID column; remove rows on `catalog.product_deleted` (**R3**) |
| TRIGGER | same migration (`product_change_log()`, `product_change_log_trg` on `"Product"`) | trigger on another owner's table feeding `ShopChangeLog` | drop; a projector consuming `catalog.product_created|updated|archived|restored|deleted` fills the feed (**R3**), idempotent by `productVersion` |
| MODEL | `sync.e2e-spec.ts:8-9,14` | `ShopModel`, `ProductModel` via `forFeature` | fixture helpers / S03 provisioning and S05 `ProductQueryService` (**R1**); no models |
| IMPORT | `api/sync.controller.ts:6` | `ShopScoped` from tenancy | allowed (decorator exported by tenancy's entry point) |
| IMPORT | `sync.module.ts:2` | `AuthModule` from identity | allowed (entry point); keep only if the guard needs it |

## D. Work list (suggested order)

1. **Contracts first.** Add `syncPushRequestSchema`, `syncPushResponseSchema` (with `syncOpResultSchema`), `syncPullResponseSchema`, `syncConflictSchema`, `syncConflictPageSchema`, `syncEventSchemas` to `packages/contracts` (A10). Problem codes from the spec's Provides list.
2. **Migration (expand/contract, `lock_timeout`).** `SyncOperation`: new unique `(shopId, opId)`, columns for user, content fingerprint, stored content, claim time, retention; keep the old primary key until code no longer reads it, then drop (A7). Feed: add `version`, `deleted`, generation and horizon columns; per-shop sequence kept (gap-free by the counter row lock). New conflict table (`SyncConflict`, owner `domain:catalog-sync`) and a handled-event table if the framework needs one — both in `db/ownership.ts` (A18, A22). `ProductFieldClock`: add `shopId`, drop the foreign key and cascade (A23). **Contract step:** drop the trigger and function (A17) only after the projector runs.
3. **Domain layer.** Pure modules: operation schemas and wire types, outcome classification and clamping arithmetic, per-field decision with the tie rule, cursor codec with generation binding, hybrid clock (clock and thresholds injected, A11, A26). Ports for repositories, the catalog gateway (stock, query, update), clock, and outbox (A29).
4. **Application services.** `SyncPushService` (claim committed first → catalog call with deterministic operation ID → record result; per-product serialization of field decisions; bounded retry; budget; takeover of stale claims) with no catalog call inside an open transaction of this domain (A1–A6, A9, A11, A13, A14). `SyncPullService` (cursor checks, bootstrap, `410`) (A15, A16). `SyncConflictService` (list, conditional dismiss, outbox event) (A18, A19).
5. **API.** Thin controllers (II.1) with DTO validation, header and body-size rules, per-device rate-limit policies, schemas from contracts (A10, A20, A21).
6. **Projector module.** Consumers of `products.events` (version-guarded, zod-validated, DLQ) building the feed (A17); consumers of `tenancy.shop_deleted` and `catalog.product_deleted` (A22). A one-off backfill for shops that already have products through `ProductCommandService.listByShop`, with a new feed generation (all old cursors answer `410`).
7. **Worker module and jobs.** `catalog-sync.redrive-stale-ops`, `catalog-sync.compact-change-log`, `catalog-sync.purge-sync-operations` registered with S49, single-run and idempotent (A12, A22).
8. **Observability.** Structured fields, counters, histogram, lag and conflict gauges (A27).
9. **Rewrite tests** to the seven e2e files and four unit files of `test-plan.md`; delete `sync.e2e-spec.ts`; no model injection; frozen clock (A24, A25).
10. **Remove** the raw SQL, the trigger, the foreign key, the `SyncService` export, and models from specs (A1–A4, A17, A23, A28); update `apps/core`, add the worker and projector modules to their apps; run `check:table-ownership --strict` and `check:boundaries` (AS-53).
11. **Hand-offs to confirm with other capabilities:** S05 exports `applyStockDelta`, `ProductCommandService.update` with `ProductValidationError`, `listByShop`, and the `catalog.product_*` events (see `questions.md` CONTRACT lines); S50 and S49 register the policies and jobs; J04 asserts the offline sale reaches search, pickup and the provider.
