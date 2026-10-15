---
description: "Task list for S09 — Offline-First Inventory Sync (domain catalog-sync)"
---

# Tasks: S09 — Offline-First Inventory Sync (domain `catalog-sync`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `questions.md` (defaults accepted).
**Paths**: `BE` = `packages/backend/libs/domains/catalog-sync`; `CT` = `packages/contracts/src/catalog-sync`; migrations in `packages/backend/migrations/`. Run backend commands from `packages/backend`; run e2e specs with `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`, the narrowest first, the whole suite once at the end in per-file batches (L-008).
**Order rule**: for every test-plan row, the failing test task comes before the code task. After 5 failed fixes of one test, stop and write the blocker into `questions.md`.
**Rules in force**: no new `sequelize.transaction` (baseline 0; use `TransactionRunner.run`/`@Transactional`); never edit `*.reviewed.json`; never use git checkout/restore/reset/stash/clean; the catalog is reached only through `@app/domains/catalog` services; no spec injects `ProductModel`/`ShopModel` (D-7); each test creates its own data (L-005, L-006) and can fail (L-003).
**Story map**: US1 stock deltas (AS-01–14) · US2 per-field LWW (AS-15–23) · US3 pull/feed (AS-24–32) · US4 bad ops and limits (AS-33–38) · US5 conflict review (AS-39–41) · US6 access/tenancy (AS-42–47) · US7 lifecycle/observability (AS-48–55).

## Phase 1: Setup

- [X] T001 Create the living-spec page `docs/spec/capabilities/S09-offline-sync.md` with rules and behaviors (push claim→catalog call→record, LWW, feed, conflicts, lifecycle) and `[proof: ...]`/`[code: ...]` pointing at the planned files; run `python3 scripts/livespec/check.py` (E1, A10). Do not create any `*.reviewed.json`.
- [X] T002 [P] Create `CT/offline-sync.ts` with zod schemas `syncPushRequestSchema` (ops 1–500, strict ops, UUIDv7 `opId`, `stock.adjust {delta ≠ 0, |delta| ≤ 100000, reason}`, `stock.count {counted ≥ 0, base ≥ 0, both ≤ 1000000}`, `product.update {fields: {title? 1..200, description? ≤10000, priceMinor? integer ≥ 0}}` ≥1 field), `syncPushResponseSchema` (+ `syncOpResultSchema`: `applied|merged|conflict|rejected|retry`, `replayed`, closed `code` list), `syncPullResponseSchema`, `syncConflictSchema`, `syncConflictPageSchema`, `syncEventSchemas` (`catalog_sync.offline_conflict_opened` v1); export from `CT/index.ts` (A10, contracts/http-api.md).
- [X] T003 [P] Add entries in `BE/rate-limit-policies.ts` (`catalogSyncRatePolicies`): `catalog-sync.sync-push.device` 30/min, `catalog-sync.sync-pull.device` 120/min (per device+shop), `catalog-sync.conflict-write.shop` 60/min; fail-closed, `429` with `Retry-After`. Check how S50 keys policies (E5); if no device key exists compose `shopId:deviceId` through S50's resolver, else record an S50 extension request in gaps.md (A20).
- [X] T004 [P] Add startup-validated config (500 ops, 2 MiB body, 20 s push budget, 60 s lease, 5 min recovery, 60 s drift, 30 d op age/feed horizon, 90 d retention) in `BE/domain/sync-config.ts` with its provider in `BE/sync.module.ts` (research R-16).

## Phase 2: Foundational (blocks all stories)

**Unit specs first (they fail until the code exists)**

- [X] T005 [P] Write `BE/domain/ops.spec.ts` (`it.each` schema table: valid/invalid ops, body `shopId`/`userId`/`deviceId` refused, non-UUIDv7 `opId`, bounds of T002) — AS-22.
- [X] T006 [P] Rewrite `BE/domain/hlc.spec.ts`: encode/decode table (`invalid_hlc`), `plausible(hlc, now, driftMs)` boundary 60 s ok / 60.001 s refused, `receive` rule, `expired(hlc, now, maxAgeMs)` — AS-19, AS-20, AS-23.
- [X] T007 [P] Rewrite `BE/domain/merge.spec.ts`: `decideFields` tie rule (same physical/counter, nodes `dev-a`/`dev-b`, both orders; equal clock loses) and `fast-check` convergence over generated device operations in all orders with duplicates, 1,000 runs, same stock and fields (SC-002) — AS-17, AS-54.
- [X] T008 [P] Write `BE/domain/outcome.spec.ts`: `classifyStock`/`clampDelta` table (`requested -3, applied -1, shortfall 2`; exact fit; over quantity limit) — AS-09, AS-10.
- [X] T009 [P] Write `BE/domain/cursor.spec.ts`: encode/decode, malformed, foreign shop, generation binding, HMAC tamper — AS-31.

**Domain code**

- [X] T010 [P] Implement `BE/domain/sync-ops.ts` (wire schemas reusing `CT`, normalised op, canonical fingerprint input: SHA-256 of `{type, productId, hlc, payload}`) until T005 passes.
- [X] T011 [P] Modify `BE/domain/hlc.ts`: drift threshold and max age passed as parameters, `server-<instance>` node, no `Date.now()`; T006 passes (A11, A13, A26).
- [X] T012 [P] Implement `BE/domain/sync-merge.ts` (per-field decision, tie rule) replacing the sync half of `BE/domain/merge.ts`; T007 passes (A25).
- [X] T013 [P] Implement `BE/domain/sync-outcome.ts` (result classification, clamp arithmetic) until T008 passes.
- [X] T014 [P] Implement `BE/domain/sync-cursor.ts` (`v1.<shopId>.<generation>.<seq>` + HMAC, base64url) until T009 passes.
- [X] T015 [P] Create ports in `BE/domain/ports/sync-*.ts` with tokens `SYNC_OPERATION_REPOSITORY`, `SYNC_FEED_REPOSITORY`, `SYNC_FIELD_CLOCK_REPOSITORY`, `SYNC_PRODUCT_EDIT_LOCK`, `SYNC_CONFLICT_REPOSITORY`, `SYNC_CATALOG_GATEWAY` (shapes per `contracts/ports.md`); reuse `SYNC_CLOCK` (A29, D-6).

**Schema and adapters**

- [X] T016 Write the migration test first: extend `BE/test/expand-migration.e2e-spec.ts` (pattern of `BE/test/data-migration.e2e-spec.ts`): populated legacy rows keep outcome, `price` clocks renamed `priceMinor`, clock rows with no derivable shop deleted (E7), fresh DB migrates both steps.
- [X] T017 Create `packages/backend/migrations/<ts>-offline-sync-expand.js` (with `lock_timeout`): `SyncOperation` add `userId`, `fingerprint char(64)`, `content jsonb`, `status`, `code`, `detail jsonb`, `quantityAfter`, `productVersion`, `claimedAt`, `completedAt`, unique `(shopId, opId)`, index `(status, claimedAt) WHERE status = 'pending'`, index `(createdAt)`, keep legacy `result`/`appliedAt`/old PK; new `SyncConflict` (unique `(shopId, opId)`, `kind` oversold|quantity_limit, `requested/applied/shortfall/quantityAfter`, `status` open|dismissed, index `(shopId, status, createdAt DESC, opId DESC)`); `ShopChangeLog` add `version int`, `deleted bool`, unique `(shopId, entityId, version)`, index `(shopId, entityId, version DESC)`; `ShopSyncState` add `generation int`, `horizonSeq bigint default 0`, `horizonAt`; `ProductFieldClock` add `shopId uuid NOT NULL`, PK `(shopId, productId, field)` (A7, A16, A18, A23).
- [X] T018 Register `SyncConflict` (owner `domain:catalog-sync`) in `packages/backend/db/ownership.ts` (A18).
- [X] T019 [P] Implement `BE/infra/repositories/sequelize-sync-operation.repository.ts`: `claim` (insert on conflict → existing row), `takeOver` (conditional on seen `claimedAt`), `complete` in one `TransactionRunner.run` (conditional `pending → terminal`, `SyncConflict` insert, `outbox.append` of `catalog_sync.offline_conflict_opened`; a re-recorded result creates neither), `listStale`, `purgeBefore`, `countPending`; every query includes `shopId`.
- [X] T020 [P] Implement `BE/infra/repositories/sequelize-sync-feed.repository.ts`: `append` under `ShopSyncState` row lock (`appended|duplicate|stale`, committed seq exactly 1…lastSeq), `page`, `bootstrap` (`DISTINCT ON`), `state`, `compact`, `startGeneration`, `deleteShop` (batches ≤1,000).
- [X] T021 [P] Implement `BE/infra/repositories/sequelize-field-clock.repository.ts` (`read`, conditional-upsert `advance`, `deleteProduct`, `deleteShop`) and `BE/infra/repositories/sequelize-sync-conflict.repository.ts` (`page` keyset, conditional `dismiss … WHERE status='open'`, `find`, `countOpen`).
- [X] T022 [P] Implement `BE/infra/pg-advisory-product-edit-lock.ts` (`SYNC_PRODUCT_EDIT_LOCK`): session-level advisory lock on a dedicated connection, not `sequelize.transaction` (E4, R-04); `.tx.baseline` stays 0.
- [X] T023 Implement `BE/infra/sync-catalog.adapter.ts` over `ProductStockService.applyStockDelta` (operation ID `sync:<shopId>:<opId>`; `rejected/insufficient_stock` is the conflict signal), `ProductQueryService.getProductsByIds`, `ProductCommandService.update` (map `ProductValidationError.errors[{field,code}]` to `invalid_field`, E6) and `listByShop`; no import of `ProductModel`; no `catalog.product_changed`, no `INSERT/UPDATE "Product"` (A1, A3, A4, D-12; S05/S08 follow-ups).
- [X] T024 Add `BE/application/sync-metrics.ts` (counters `catalog_sync_offline_ops_total{type,status}`, histogram `catalog_sync_offline_push_duration_seconds`, gauges `…feed_lag_seconds`, `…conflicts_open`, `…ops_in_flight`) and a structured log helper (`requestId`, `shopId`, `deviceId`, per-op `opId,type,status,code,durationMs`; never titles/bodies) (A27). *(Built as `application/offline-sync-metrics.ts`: `sync-metrics.ts` is S08's file.)*

**Checkpoint**: `pnpm jest libs/domains/catalog-sync/domain` green; expand migration test green; `tsc --noEmit` clean.

## Phase 3: US1 — Stock deltas converge (P1) 🎯 MVP

**Independent test**: `sync-push.e2e-spec.ts` AS-01–14 green.

- [X] T025 [US1] Write `BE/sync-push.e2e-spec.ts` (describe "Offline sync: push, operation idempotency and stock deltas"; real `OfflineSyncModule`, worker and projector modules with tenancy, identity, catalog, outbox, rate-limiter; production pipe/filter/prefix; frozen clock; products via catalog services only; responses parsed with contract schemas; assert body and persisted state) with AS-01 (+3/−1 both orders → 12, one catalog event per op, none written by this domain), AS-02 (ten replays, `replayed: true`, original `quantityAfter`), AS-03 (`Promise.all` same batch → one effect), AS-04 (`op_id_reused`), AS-05 (IDs scoped to shop), AS-06 (`counted 8, base 10`, quantity 9 → 7, `delta -2`), AS-07 (count confirms: no catalog call/event), AS-08 (concurrent last-unit sells → one `applied`, one `conflict`, quantity 0, one open conflict, one outbox event; carries the legacy case "selling the last unit twice is a reviewable conflict", L-017), AS-09 (`requested -3, applied -1, shortfall 2`), AS-10 (`quantity_limit`), AS-11 (identical `unknown_product` bodies for unknown/foreign), AS-12 (`product_unavailable`), AS-13 (store rule refuses the result write once → `503`, +61 s, repeat → one effect, one event; force the fault), AS-14 (45 s `in_flight`; 61 s takeover once; recovery job twice and on two instances → once). Run it; confirm it fails for the right reasons.
- [X] T026 [US1] Implement `BE/application/sync-push.service.ts` stock path: ops in request order; claim committed first; fingerprint compare (`op_id_reused`, `replayed`); `stock.adjust` and `stock.count` (delta from counted/base per AS-06) via the gateway with the deterministic ID; clamp by a second `applyStockDelta` `…:clamp` (≤3 attempts) and `oversold` conflict; `quantity_limit`; `unknown_product`/`product_unavailable`; no catalog call inside an open transaction; stock deltas ignore clock drift (A1, A2, A4, A6, A7, A11).
- [X] T027 [US1] In `BE/application/sync-push.service.ts` implement takeover of stale claims (60 s lease) and the `in_flight` result; add `redriveStale` in `BE/application/sync-lifecycle.service.ts` (claims older than 5 min completed from stored `content` through the push path) (AS-13, AS-14).
- [X] T028 [US1] Create `BE/api/sync.controller.ts` push route (thin: DTO/zod pipe from contracts, `X-Device-Id` pipe, `ShopScoped`, `products.write`) and `OfflineSyncModule` in `BE/sync.module.ts` wiring ports→adapters, exporting only the module (A10, A28). Run `test-spec.sh BE/sync-push.e2e-spec.ts` until AS-01–14 pass.

## Phase 4: US2 — Per-field LWW (P1)

**Independent test**: `sync-fields.e2e-spec.ts` AS-15–23 green.

- [X] T029 [US2] Write `BE/sync-fields.e2e-spec.ts` (describe "Offline sync: per-field last-writer-wins"): AS-15 (title and price both survive, both orders, clocks stored), AS-16 (stale edit `merged`, no event; mixed edit applies only the newer field), AS-18 (`Promise.all` ×20 random order → greatest clock wins; first-edit race A5), AS-19 (+61 s edit `clock_implausible`, clocks unchanged; stock op with same skew applies), AS-20 (`invalid_hlc`, `hlc_node_mismatch`), AS-21 (30 d + 1 s `op_expired`), AS-22 (`invalid_op` paths, `invalid_field` from catalog, valid ops applied, no clock advanced), AS-23 (`serverHlc` above accepted clocks, monotonic per instance). Run; confirm failing.
- [X] T030 [US2] Implement the `product.update` path in `BE/application/sync-push.service.ts`: `SYNC_PRODUCT_EDIT_LOCK` per product, read clocks, `decideFields`, `ProductCommandService.update` with expected version, bounded retry 3 on version conflict then `retry`/`contention`, `merged`/`applied` with `applied[]`/`superseded[]`, clocks advanced only after success; plausibility, expiry and node checks (A3, A5, A11, A12).
- [X] T031 [US2] Add the per-instance monotonic server HLC (`receive` of accepted clocks) in `BE/application/sync-clock.service.ts`, used by push and pull responses (A13); T029 passes.

## Phase 5: US3 — Pull and feed (P1)

**Independent test**: `sync-pull.e2e-spec.ts` and `sync-feed-consumer.e2e-spec.ts` green.

- [X] T032 [US3] Write `BE/sync-pull.e2e-spec.ts` (describe "Offline sync: pull and change feed"): AS-24 (online create, dashboard edit, push → three entries, consecutive `seq`, empty second pull), AS-25 (5 changes, `limit=2` → 2/2/1), AS-30 (push `productVersion` equals pulled `version`), AS-31 (malformed, foreign-shop cursor, limits `0`, `501`, `abc` → `400`, no fallback), AS-32 (old generation, ahead of head, past horizon → `410 resync_required`; no cursor returns full state; generation bump after backfill → `410`).
- [X] T033 [US3] Write `BE/sync-feed-consumer.e2e-spec.ts` (describe "Offline sync: change feed consumers"): AS-26 (30 concurrent events → `seq` 1…30, repeated pulls miss nothing), AS-27 (version 7 twice → one entry; 6 after 7 ignored), AS-28 (each bad payload dead-lettered, feed unchanged, next event processed), AS-29 (archive, restore, delete tombstone in order).
- [X] T034 [US3] Implement `BE/infra/sync-feed.consumer.ts` (`catalog-sync-offline-feed`, group name different from S08's; consumed event definitions re-declared like `infra/product-events.consumer.ts`; zod, envelope check, version guard, DLQ) and `OfflineSyncProjectorModule` in `BE/sync.module.ts` (A17, A22).
- [X] T035 [US3] Implement `BE/application/sync-pull.service.ts` (`invalid_cursor`/`410`, bootstrap with tombstones within horizon, limit 1–500 default 200, `serverHlc`) and the pull route in `BE/api/sync.controller.ts` (`products.read`, `X-Device-Id` required, `Cache-Control: no-store`) (A15, A16, A21).
- [X] T036 [US3] Implement the backfill handler for `catalog-sync.backfill-change-log` in `BE/application/sync-lifecycle.service.ts`: rebuild a shop's feed through `ProductCommandService.listByShop` with a new `generation` (R-07, A16).

## Phase 6: US4 — Bad operations never block the queue; limits (P1)

**Independent test**: AS-33–38.

- [X] T037 [US4] Extend `BE/sync-push.e2e-spec.ts` with AS-33 (middle op invalid → `applied`, `invalid_op`, `applied`), AS-34 (same op twice in a batch → `replayed: true`; different content → `op_id_reused`), AS-37 (slow store, 120 results + 380 `deadline_exceeded`, resend completes once; force the fault), AS-38 (store failure mid-batch → `503 sync_unavailable` with generic detail, earlier ops durable, resend replays; force the fault).
- [X] T038 [US4] Start `BE/sync-access.e2e-spec.ts` (describe "Offline sync: access, tenancy and limits") with AS-35 (every envelope class `400`, empty `ops`, >500 ops, unknown top-level field, body >2 MiB `413`, nothing applied) and AS-36 (push and pull `429` with `Retry-After`, nothing applied, applies after window).
- [X] T039 [US4] In `BE/application/sync-push.service.ts` and `BE/api/sync.controller.ts` implement per-op rejection (no whole-batch `400`), the 20 s budget with `deadline_exceeded`, `503 sync_unavailable` problem mapping with generic detail, the 2 MiB body limit, and `RateLimit` with the T003 policies on push and pull (A9, A14, A20).

## Phase 7: US5 — Conflict review (P2)

**Independent test**: `sync-conflicts.e2e-spec.ts` AS-39–41.

- [X] T040 [US5] Write `BE/sync-conflicts.e2e-spec.ts` (describe "Offline sync: conflict review"): AS-39 (3 open + 2 dismissed, `limit=2`, `status`, invalid params `400`), AS-40 (dismiss `200`, second `409 conflict_not_open`, concurrent → one `200` one `409`), AS-41 (other shop's ID `404`; viewer list ok, dismiss `403`); outbox payload parsed with `syncEventSchemas`.
- [X] T041 [US5] Implement `BE/application/sync-conflict.service.ts` and `BE/api/sync-conflicts.controller.ts` (list `products.read`, dismiss `products.write`, `conflict-write.shop` policy), replacing the raw list in `api/sync.controller.ts` (A18, A19).

## Phase 8: US6 — Access and tenancy (P1)

**Independent test**: AS-42–47 in `sync-access.e2e-spec.ts`.

- [X] T042 [US6] Extend `BE/sync-access.e2e-spec.ts` with AS-42 (all four routes `401`), AS-43 (one user per role × four routes against the matrix), AS-44 (shop A member on `/shops/B/…` → identical `404`; no B entry in A's pull), AS-45 (removed member's push `404`, nothing applied), AS-46 (`403 shop_suspended`, `409 shop_offboarding`, pull follows the gate), AS-47 (body `shopId`/`userId`/`deviceId` refused; stored op has path, session, header values).
- [X] T043 [US6] Make T042 pass in `BE/api/sync.controller.ts` and `BE/application/sync-push.service.ts`: `userId` recorded on the claim, clock node must equal `X-Device-Id` on push and pull, identity only from the session (A7, A21).

## Phase 9: US7 — Lifecycle, jobs, observability (P3)

**Independent test**: `sync-lifecycle.e2e-spec.ts` AS-48–52, 55.

- [X] T044 [US7] Write `BE/sync-lifecycle.e2e-spec.ts` (describe "Offline sync: lifecycle jobs and observability"): AS-48 (`tenancy.shop_deleted` twice → rows gone once, other shop untouched, invalid payload dead-lettered), AS-49 (`catalog.product_deleted` twice → clocks gone once, operations stay), AS-50 (95/85/10-day records and a 120-day open conflict; purge job twice and on two instances), AS-51 (log fields, no titles/bodies; metric names and values), AS-52 (events written by the catalog, one stock command per op with the deterministic ID, replay adds none), AS-55 (frozen clock, compaction job twice and on two instances, young cursor's final state unchanged).
- [X] T045 [US7] Implement `BE/infra/sync-lifecycle.consumers.ts` (`catalog-sync-offline-product-deleted`, `catalog-sync-offline-shop-deleted`; idempotent deletes, batches ≤1,000, zod, DLQ) registered in `OfflineSyncProjectorModule` (A22).
- [X] T046 [US7] Implement `BE/infra/offline-sync.jobs.ts` and `OfflineSyncWorkerModule`: `declareJobType({name, contract: z.object({…}).strict()})` next to the `JobPayloads` augmentation for `catalog-sync.redrive-stale-ops` (every minute), `catalog-sync.compact-change-log` (daily), `catalog-sync.purge-sync-operations` (daily) and internal `catalog-sync.backfill-change-log`; single-run with leases; wrap `upsertSchedule` in `try/catch InvalidScheduleError` with a fatal boot log; never call `JobsService.cancel` (E3, A12, A22).
- [X] T047 [US7] Implement compaction (`compact`, set `horizonSeq/horizonAt`) and purge (90 d, open conflicts excepted) in `BE/application/sync-lifecycle.service.ts`; wire the T024 metrics and logs into push, pull and jobs, including the feed-lag gauge (A12, A27).

## Phase 10: Contract migration, removal, wiring (Polish)

- [X] T048 Add the boundary test first in `BE/test/expand-migration.e2e-spec.ts`: after the contract migration no FK from `ProductFieldClock` and no `product_change_log_trg` exist (AS-53).
- [X] T049 Create `packages/backend/migrations/<ts>-offline-sync-contract.js` (with `lock_timeout`): drop trigger `product_change_log_trg` and function `product_change_log()`, drop the `ProductFieldClock → Product` FK/cascade, drop the legacy `SyncOperation` primary key and legacy `result`/`appliedAt` columns (A17, A23, D-12).
- [X] T050 Delete `BE/application/sync.service.ts` (with the S05 "repair step") and the legacy `BE/sync.e2e-spec.ts` (its scenario lives on as AS-08/AS-09, L-017); remove `ShopModel`/`ProductModel` use (D-7) and the old `domain/merge.ts` half (A1–A4, A24, A29).
- [X] T051 Update `BE/index.ts` to export `OfflineSyncModule`, `OfflineSyncWorkerModule`, `OfflineSyncProjectorModule` and no `SyncService`; import them in `apps/core`, the worker app, `apps/projector` and `apps/local-monolith` (D-8, A28).
- [X] T052 Update only the pinned export list in `BE/integration-boundary.e2e-spec.ts` (AS-80) to include the two new module names; run `integration-boundary` and `integration-stock` specs (quickstart #15). The sibling bullet already sits in gaps.md.
- [X] T053 Search `BE/` for `sequelize.transaction` and `// S54 T037 audit`; migrate any site in a touched file; confirm the domain count is not above baseline 0.
- [X] T054 Gate checks: `pnpm --dir packages/backend check:table-ownership --strict` (zero S09 findings; reconcile gaps.md section C), `pnpm check:boundaries`, `pnpm tsc --noEmit` (backend, contracts), ESLint, `python3 scripts/livespec/check.py`.
- [X] T055 Update `docs/spec/capabilities/S09-offline-sync.md` so every `[proof: ...]`/`[code: ...]` names the final specs and files; rerun `check.py`.
- [X] T056 Boot proofs (L-004, L-015, L-018): start `apps/core`, the worker app and `apps/projector` each alone, then `apps/local-monolith`; hit health and `GET /shops/:id/sync/pull`; no missing import or provider (quickstart #12). **Status**: core, worker and projector each boot alone in `apps/*/src/offline-sync-wiring.e2e-spec.ts` (health, routes, schedules, consumers declared). The monolith cannot boot inside jest (it needs the BFF settings); its boot, and the health + pull check against it, are left to the checkpoint scripts (L-019). deferred to the final checkpoint: scripts/infra/boot-app.sh local-monolith, then curl /health and GET /shops/:id/sync/pull.
- [X] T057 Final run (L-008, L-012, L-019): `scripts/qa/fresh-run.sh`, then every `catalog-sync` e2e file in its own batch via `test-spec.sh` plus `pnpm jest libs/domains/catalog-sync/domain`; each batch must print its summary line. **Status**: the domain unit specs and every S09 e2e file (plus integration-boundary, integration-stock, the migration specs, rate-limit registry, jobs) were run green, each in its own batch; `scripts/qa/fresh-run.sh` builds a throwaway Docker stack and runs the browser suite, which L-019 leaves to the final checkpoint, so it was not run here. deferred to the final checkpoint: scripts/qa/fresh-run.sh --here.
- [X] T058 Confirm SC-003 stays under "Ops artifacts" in `quickstart.md` and has its row (status `not run`) in `specs/UNVERIFIED.md` (already present); never describe it as verified (E9).
- [X] T059 Keep gaps.md current: "Sibling-spec follow-ups" (S08, S05, S50, S49, J04, W04) and "Spec changes: None"; in the final report list the S05/S08/S49 follow-ups handled (applyStockDelta only, `priceMinor`, no `catalog.product_changed`, `declareJobType`, `InvalidScheduleError`).

## Dependencies and order

- Phase 1 → Phase 2 → stories. T016–T018 before T019–T021; T023 needs T015.
- US1 is the MVP and creates the module and controller (T028); US2 and US4 extend `sync-push.service.ts` (same file: sequential, not [P]); US3 and US5 depend only on Phase 2 plus T028; US6 follows T028; US7 follows US1 and US3.
- Phase 10 after all stories; T049 only after no code reads the legacy columns.

## Parallel examples

- Phase 2: T005–T009 together, then T010–T015, then T019–T022.
- After T028: US3 (T032–T036) and US5 (T040–T041) in parallel with US2's test task T029.

## Gap coverage

A1–A4 T023, T026, T050 · A5 T029–T030 · A6 T026 · A7 T017, T026, T043 · A8–A10 T002, T010, T028 · A11–A14 T011, T030, T031, T039 · A15–A17 T017, T034–T036 · A18–A19 T019, T041 · A20–A21 T003, T039, T043 · A22–A23 T045, T046, T049 · A24–A25 T005–T009, T025–T044, T050 · A26 T011 · A27 T024, T047 · A28–A29 T015, T051 · D-6 T015–T021 · D-7 T050 · D-8 T051 · D-12 T023, T049 · section C ownership T018, T054 · E1–E9 T001, T050, T046, T022, T003, T023, T017, T056, T058.
