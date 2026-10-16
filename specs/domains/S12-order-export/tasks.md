# Tasks: S12 — Order Export (domain `orders`)

**Input**: `specs/domains/S12-order-export/` — plan.md, spec.md (AS-01–AS-61, FR-001–FR-040, SC-001–SC-009), test-plan.md, gaps.md (A1–A24, B, C, D, E), data-model.md, contracts/http.md, contracts/async.md, research.md (R-01–R-14), quickstart.md, questions.md (defaults accepted).

**Paths**: all under `packages/backend/` unless they start with `packages/contracts/`, `docs/`, `scripts/` or `specs/`. `ORD` = `libs/domains/orders`. Backend commands run from `packages/backend`. Run tests only through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`; open the full log only when the condensed output is not enough. After 5 failed fixes of the same test, stop and write the blocker into `questions.md`.

**Rules that apply to every task**
- Test-first (VII.9): every test task of a story comes before the code task it proves and must be seen **red** for the right reason (not a compile error of a missing helper) before the code lands.
- Cross-spec: living-spec page first (T003); never create/edit `*.reviewed.json`; never use git checkout/restore/reset/stash/clean (undo by hand-editing only the named lines); transactions only through `TransactionRunner.run` / `@Transactional`, no new direct `sequelize.transaction`; sibling specs are not edited (follow-ups live in gaps.md).
- Known-failure guard: L-001 (no `groupId`/`dedupeId` on `order-exports`), L-002/L-020 (queue in `elasticmq.conf` + reload + readiness), L-003 (no "A or B" assertions), L-004/L-015/L-018 (each app boots standalone), L-005/L-006 (each test creates its own shop/orders/exports), L-008 (large cases in their own file/batch), L-010 (409 + `activeExportId`), L-013 (fault tests clean up in `afterEach`), L-016 (repair jobs never throw on the condition they repair), L-017 (keep `AS-nn` in test titles), L-019 (runtime proofs run by the final checkpoint script).
- Every task that adds a `[code:]`/`[proof:]` marker keeps `python3 scripts/livespec/check.py` green.

## Format: `- [ ] Tnnn [P] [USn] description with file path`

---

## Phase 1: Setup

- [X] T001 Reconcile baselines (gaps D.1, C): run `pnpm --dir packages/backend check:table-ownership` and `pnpm check:boundaries`; write the real output for `orders` and `catalog-sync` into a short "Baseline (real run)" section at the end of `specs/domains/S12-order-export/research.md` and note any difference from gaps.md §C (S10/S11/S13 findings are listed, not fixed here).
- [X] T002 [P] Verify the follow-up inventory is still true and record each result under "Follow-ups verified" in `specs/domains/S12-order-export/research.md`: `externalSku` on `ProductDto` (S05), `title`/`discountMinor`/`lineTotalMinor` on `BisOrderItem` (S10), `declareJobType` + `InvalidScheduleError` (S49), prefix `order-export` in `ORD/api/realtime-topics.ts` (S51), `Projector` with `idempotency: 'inbox'` (S53), `ShopMembership` registration at `apps/projector/src/projector.module.ts:36,154` (G-54).
- [X] T003 Create the living-spec page `docs/spec/capabilities/S12-order-export.md` FIRST (rule 0): rules and behaviors for start/idempotency/one-active, file content, streaming, progress and live channel, failure/cancel/recovery, retention and shop events, removal from catalog-sync. Use `[proof: …]` pointing at the e2e/unit files named below (files may not exist yet: add each marker in the task that creates its file) and `[code: …]` added as code lands. Run `python3 scripts/livespec/check.py`. Do not touch any `*.reviewed.json`.
- [X] T004 [P] Add the queue pair to `infra/docker/elasticmq/elasticmq.conf`: `order-exports` (standard, not FIFO) and `order-exports-dlq`, `maxReceiveCount 3` on the main queue (A21, L-002, L-020); add the same pair to `infra/stack/main.tf` plus the one-day abort-incomplete-multipart lifecycle rule note; reload the queue server with the repo's documented command (record the command in quickstart.md if absent) and confirm `queueExists('order-exports')`.
- [X] T005 [P] Add the five e2e file shells (empty `describe` with the exact top-level names from test-plan.md, no tests yet) in `ORD/order-export.e2e-spec.ts`, `ORD/order-export-streaming.e2e-spec.ts`, `ORD/order-export-progress.e2e-spec.ts`, `ORD/order-export-worker.e2e-spec.ts`, `ORD/order-export-lifecycle.e2e-spec.ts`, and the shared fixture helper `ORD/testing/order-export.fixtures.ts` (`F5` builder: shops `S`/`S2`, users `U`,`W`,`V`,`X`,`N`, the five lines and amounts of spec.md; a gating/failing/stalling wrapper around the storage port; a recording spy over `ProductQueryService.getProductsByIds`; a failing realtime publisher; `appA`/`appB` factory; injected frozen clock `T = 2026-10-05T09:00:00.000Z`). Each test creates its own shop and data (L-005, L-006).

---

## Phase 2: Foundational (blocks every story)

**Contracts**

- [X] T006 [P] Add `packages/contracts/src/orders/order-export.ts` and export from the package index: `orderExportCreateRequestSchema = z.strictObject({})`, `orderExportSchema` (strict; fields exactly as contracts/http.md; `status` six values; `failure: {code, message}|null`; never `fileKey`, `shopId`, lease), `orderExportPageSchema {items, nextCursor: string|null}`, `orderExportDownloadSchema {url: url, expiresAt: iso}`, `orderExportProgressEventSchema` (discriminated union on `type`: `progress {rowsWritten,totalRows,bytesWritten}`, `done {rowsWritten,bytesWritten}`, `failed {code}`, `cancelled {}`), `orderExportEventSchemas` (`order_export.finished` v1 envelope + payload of contracts/async.md), `ExportFailureCode` union (`storage_unavailable | catalog_unavailable | database_unavailable | row_limit_exceeded | timeout | shop_not_found | attempts_exhausted | internal_error`) and the problem-code union of spec.md §Provides (A5, FR-040).

**Domain pure rules — unit specs first, then code**

- [X] T007 [P] Write `ORD/domain/export-state.spec.ts` (AS-61): `it.each` over all 36 ordered pairs of the six statuses; allowed set exactly QUEUED→RUNNING, QUEUED→CANCELLED, RUNNING→DONE|FAILED|CANCELLED|QUEUED, DONE→EXPIRED; exhaustiveness via `assertNever`. Must fail (module missing).
- [X] T008 [P] Write `ORD/domain/export-csv.spec.ts` (AS-13, AS-14): `it.each` cells `plain`, `a,b`, `say "x"`, LF, CR, `  padded  `, `日本語 🚀`, empty, 10,000-char title → quoting/doubling rules, fields comma-separated, records end CRLF, deterministic bytes; formula guard for `= + - @ TAB CR` start → single leading apostrophe then quoted as AS-13, neutral starts unchanged, numeric columns and IDs never modified; BOM + exact header constant.
- [X] T009 [P] Write `ORD/domain/export-progress.spec.ts` (AS-16): `it.each` none→publish; 999 ms→skip; 1,000 ms→publish; last batch→always; clock backwards→publish and reset; frozen clock 25 batches→exactly two events.
- [X] T010 [P] Write `ORD/domain/export-failure.spec.ts` (AS-35): `it.each` storage error / inactivity timeout / upload abort → retry `storage_unavailable`; catalog timeout/error → retry `catalog_unavailable`; order-store timeout, connection reset, deadlock, serialization → retry `database_unavailable`; row limit → fail `row_limit_exceeded`; deadline → fail `timeout`; shop gone → fail `shop_not_found`; other → fail `internal_error`; third delivery turns a retry into a failure with the same code; unknown class is `internal_error`.
- [X] T011 [P] Implement `ORD/domain/export-state.ts` (status union, transition table, `canTransition`, `assertNever` switch) so T007 passes. No framework/clock/I/O imports (FR-039).
- [X] T012 [P] Implement `ORD/domain/export-csv.ts` (header constant, BOM, `encodeRecord(row)`, `encodeCell`, formula guard on `sku` and `title` only; money as decimal strings, never `Number`) so T008 passes.
- [X] T013 [P] Implement `ORD/domain/export-progress.ts` (`shouldPublishProgress(now, lastEventAt|null, isLast)`) so T009 passes.
- [X] T014 [P] Implement `ORD/domain/export-failure.ts` (closed `classify(errorClass, delivery)` table; one fixed generic message per code, e.g. `storage_unavailable` → "The file could not be stored. Start a new export.") so T010 passes.
- [X] T015 [P] Implement `ORD/domain/export-row.ts` (`ExportRow` with money as decimal strings, `KeysetPosition {createdAt ISO ms, shopOrderId, lineId}`, strict-parsed opaque list cursor `{createdAt,id}` base64url → `invalid_cursor`, pure legacy fallbacks: `title` null → catalog title, `lineTotalMinor` null → `quantity*unitPriceMinor-discountMinor` with BigInt), `ORD/domain/export-config.ts` (defaults and `validateExportConfig` naming the failing key: batch ≥ 1, row limit ≥ 1, retention > 0, lease ≥ 2 × heartbeat, user-content origin required in production — AS-59), `ORD/domain/export-errors.ts` (typed errors → problem codes `export_not_found`, `export_not_ready`, `export_expired`, `export_not_cancellable`, `export_already_active {activeExportId}`), `ORD/domain/export-ports.ts` (tokens and interfaces `EXPORT_JOBS`, `EXPORT_LINES`, `EXPORT_FILES`, `EXPORT_SKUS`, `EXPORT_LIVE`, `EXPORT_QUEUE`, `CLOCK` per data-model.md).

**Storage / queue port extensions (A20, A21)**

- [X] T016 Write failing tests for the storage extension in `libs/infrastructure/storage/object-storage.spec.ts` (or the existing storage spec file): `put` honours `signal` (aborts the multipart upload, leaves no object and no incomplete upload) and `inactivityTimeoutMs` (stalled source aborts); in-memory `abortMultipartUpload` really discards parts; `presignGet` sets `Content-Disposition: attachment; filename="orders-<id>.csv"` (RFC 6266 quoting, not `encodeURIComponent`), `text/csv`, and the user-content origin.
- [X] T017 Implement T016 in `libs/infrastructure/storage/s3-object-storage.ts:67-78,120-127`, `libs/infrastructure/storage/in-memory-object-storage.ts:34,42` and the port file; additive options only (S07 shares the port). Confirm the existing storage specs stay green.
- [X] T018 [P] Confirm in `libs/infrastructure/sqs/task-queue.port.ts` that `enqueue({delaySeconds})`, `receiveCount` and `consume(..., {bodySchema})` with heartbeat exist (A21); if a gap shows, add the narrowest change with a test. No FIFO-only option on `order-exports` (L-001): add a unit assertion in the producer adapter (T040) that `groupId`/`dedupeId` are never passed.

**Database**

- [X] T019 Write the expand migration `migrations/2026101*-orders-export-expand.js` (A12, A15): `SET lock_timeout`; add `attempt int not null default 0`, `totalRows bigint null`, `rowsWritten bigint not null default 0`, `bytesWritten bigint not null default 0`, `failureCode text null`, `fileKey text null`, `leaseHolder uuid null`, `leaseExpiresAt timestamptz null`, `startedAt`, `finishedAt`, `expiresAt timestamptz null`, `updatedAt timestamptz not null`; widen the `status` CHECK to `QUEUED,RUNNING,DONE,FAILED,CANCELLED,EXPIRED` (default `QUEUED`); **drop** `ExportJob_shopId_fkey` and `ExportJob_createdBy_fkey`; batch backfill `rows → rowsWritten`, `error → failureCode='internal_error'` where `status='FAILED'`; legacy `RUNNING` rows get `leaseExpiresAt = now()`; create `ExportJobHistory` (`id uuid pk`, `exportId uuid not null`, `shopId uuid not null`, `fromStatus text null`, `toStatus text not null`, `reason text null`, `actor uuid null`, `at timestamptz not null`; no FK; index (`exportId`,`at`)); indexes `ix_exportjob_shop_created (shopId, createdAt DESC, id DESC)`, `ix_exportjob_lease (leaseExpiresAt) WHERE status='RUNNING'`, `ix_exportjob_finished (finishedAt) WHERE status IN ('DONE','FAILED','CANCELLED','EXPIRED')`; the unique partial index `ux_exportjob_active_per_shop (shopId) WHERE status IN ('QUEUED','RUNNING')` built `CONCURRENTLY` in its own non-transactional migration step (FR-003). Leave `kind`, `rows`, `error`, `objectKey` in place. Verify an idempotent re-run and apply on a populated copy.
- [X] T020 [P] Add `ExportJobHistory: 'domain:orders'` to `db/ownership.ts` (keep `ExportJob`) in the same change as T019 (A15, C).
- [X] T021 [P] Add Sequelize models `ORD/infra/models/export-job.model.ts` and `ORD/infra/models/export-job-history.model.ts` (plain ID columns, no associations, not exported from the barrel).
- [X] T022 Write the repository adapter `ORD/infra/export-job.repository.ts` implementing `EXPORT_JOBS`: create-with-active-guard (unique-violation → `export_already_active` with the winner's id), claim (conditional `QUEUED→RUNNING`, `attempt+1`, new `leaseHolder` uuid, lease expiry), heartbeat/record-progress/finish/release/cancel all with `status` + `leaseHolder` + `leaseExpiresAt>now()` in the predicate and exactly-one-row check, each transition plus its `ExportJobHistory` row (and the outbox `order_export.finished` append for DONE/FAILED/CANCELLED) in one `TransactionRunner.run`; list/get always with `shopId` in the predicate; recovery, expiry, purge selects; delete-by-shop in bounded chunks. No `sequelize.transaction`.
- [X] T023 [P] Add `ORD/application/events/order-export-finished.event.ts` (`defineEvent` for `order_export.finished` v1 using `orderExportEventSchemas`) and register topic `order-exports.events` in the events topic registry (contracts/async.md).

**Checkpoint**: contracts, pure domain, ports, tables and repository exist; unit specs T007–T010 green; migration applies; `tsc` clean.

---

## Phase 3: User Story 1 — A seller exports the shop's orders as a CSV (P1) 🎯 MVP

**Goal**: start, run, file, download. **Independent test**: `F5` through the real routes and worker entry; compare bytes.

### Tests first (red)

- [X] T024 [P] [US1] In `ORD/order-export.e2e-spec.ts` write AS-01 (start: 202, `Location`, body parsed by `orderExportSchema`; one job, one history row, one message on `order-exports`, none on `catalog-imports`, nothing in storage, no outbox row), AS-02 (worker run: `DONE`, `attempt 1`, `totalRows 5`, file of header + 5 lines, history, outbox row, live events, `GET` equals final state), AS-03 (BOM, exact header, `L1`/`L2` records, `9007199254740993` digit for digit, ISO UTC ms timestamps, no personal data).
- [X] T025 [P] [US1] In the same file write AS-04 (empty shop: BOM + header only, `bytesWritten` = size, `done {0,bytes}`), AS-05 (download `{url, expiresAt: T+10min}`, attachment/`orders-<E>.csv`/`text/csv`, fetch returns exact bytes, one `order_export_downloaded` log line without link), AS-06 (two exports byte-identical).
- [X] T026 [P] [US1] In the same file write AS-07 (spy: exactly 2 `getProductsByIds` calls of 500 and 200 ids, each `{shopId}`; deleted product → empty SKU; snapshot title not the renamed catalog title) and AS-08 (`S` 5 lines, `S2` 1 line, legacy null-shop line in neither).

### Implementation

- [X] T027 [US1] Implement `ORD/infra/export-line.reader.ts` (`EXPORT_LINES`): `count(shopId, until)` and `batches(shopId, until, position)` as an async generator; each batch is one short `SELECT … LIMIT :batch` through the pool (no transaction, no cursor, no pinned connection) over `ShopOrder`/`BisOrder`/`BisOrderItem` with `shopOrder.shopId = :shopId AND item.shopId = :shopId AND shopOrder.createdAt <= :until`, keyset `(so.createdAt, so.id, item.id) > (:c,:s,:l)`, `order_id` = BisOrder id, `created_at` = shop order's creation time, money via text cast (no float). No `Product` table, model or join (A10, A24).
- [X] T028 [P] [US1] Implement `ORD/infra/export-sku.adapter.ts` (`EXPORT_SKUS`): `lookup(shopId, ids)` chunks distinct ids by 500 and calls `ProductQueryService.getProductsByIds(ids, {shopId})` once per chunk (never per line), returns `Map<id,{sku,title}>`, absent ids → empty SKU; timeout/failure surfaces as the catalog error class (S05 follow-up).
- [X] T029 [P] [US1] Implement `ORD/infra/export-file.sink.ts` (`EXPORT_FILES`): per-attempt key `exports/<shopId>/<exportId>/attempt-<n>-<token>.csv`, `put` with `signal` + `inactivityTimeoutMs`, `head` size, `delete`, `presign` (10 min, attachment name `orders-<id>.csv`, user-content origin). Never log the key or link.
- [X] T030 [US1] Implement `ORD/application/order-export-run.service.ts` (happy path first): claim → count `totalRows` bounded by `createdAt` → one `stream/promises.pipeline` of async generator → object-mode transform (SKU batch lookup, CSV encode) → sink, `highWaterMark` sized for AS-11; counters recorded per batch; completion is the single fenced transaction writing `fileKey`, `DONE`, `finishedAt`, `expiresAt = finishedAt + 7 d`, history and outbox row; live `done` published after commit and never awaited inside a transaction.
- [X] T031 [US1] Implement `ORD/application/order-export-command.service.ts` (`start`, `download`) and `ORD/application/order-export-query.service.ts` (`get`) with the failure/error mapping of `domain/export-errors.ts`; `start` enqueues `{exportId}` after commit through `ORD/infra/export-queue.adapter.ts` (`EXPORT_QUEUE`, standard queue, no `groupId`/`dedupeId`, T018).
- [X] T032 [US1] Implement `ORD/infra/order-export.consumer.ts` (queue consumer, `bodySchema = z.strictObject({exportId: uuid})`, concurrency from config, visibility 5 min with heartbeat) delegating to the run service.
- [X] T033 [US1] Implement `ORD/api/order-export.controller.ts` + `ORD/api/order-export.dto.ts` for `POST /shops/:shopId/order-exports` (202 + `Location`), `GET …/:exportId`, `GET …/:exportId/download`: `ShopScoped('orders.manage')`, uuid param pipe, zod body pipe with `orderExportCreateRequestSchema`, one service call per method; the DTO mapper never emits `fileKey`, `shopId`, lease or key; the download writes the `order_export_downloaded` structured log line `{exportId, shopId, userId}`.
- [X] T034 [US1] Create `ORD/order-export.module.ts` (core: controller, command/query services, adapters), `ORD/order-export-worker.module.ts` (worker: consumer, run service; jobs and tenancy consumers join in later stories) and wire the ports by token. Do NOT yet remove the old code; both coexist until T070.
- [X] T035 [US1] Run `test-spec.sh libs/domains/orders/order-export.e2e-spec.ts` until T024–T026 are green; add `[proof:]`/`[code:]` markers to the living-spec page (T003); `python3 scripts/livespec/check.py`.

**Checkpoint**: MVP — start, run, download work on real stack for AS-01–AS-08.

---

## Phase 4: User Story 2 — Constant memory, no lost or repeated line (P1)

**Goal**: batch correctness, no held connection, backpressure, benchmark. **Independent test**: 2,500 same-timestamp lines; 50,000 lines with gated storage.

### Tests first (red)

- [X] T036 [P] [US2] In `ORD/order-export-streaming.e2e-spec.ts` write AS-09 (2,500 identical timestamps; 0, 1,000, 1,001 lines; a shop order whose 3 lines straddle a batch boundary; each line once in (shop-order time, id, line id) order; `rowsWritten == totalRows`) and AS-10 (export of 3,000 lines paused after first batch by the gated storage wrapper; new order + status change; `pg_stat_activity` shows no open transaction and no connection held; file excludes the new order, shows earlier status as read at its batch, 3,000 lines once).
- [X] T037 [P] [US2] Write AS-11 in its **own** file `ORD/order-export-backpressure.e2e-spec.ts` (L-008): 50,000 lines, storage accepts nothing, assert ≤ 3,000 lines read (reader counter), release → completes with 50,000 lines once. Add this file to quickstart §1 and to the suite list (T086).
- [X] T038 [US2] Write the benchmark script `scripts/bench/order-export-bench.ts` (A23, AS-12): generate N lines (`--lines`), run the real pipeline, print time and peak heap, `--verify` (hash of two runs byte-identical, SC-003 100k part), `--chaos <k>` (kill at k random points, SC-005). Exits non-zero over 5 min or 200 MB. Mark it as run-by-hand; do not describe it as verified (it is an Ops artifact).

### Implementation

- [X] T039 [US2] Tune `export-line.reader.ts` / `order-export-run.service.ts` until T036–T037 are green: pull-based `Readable.from(generator, {highWaterMark: 1})`, transform `highWaterMark` so read-ahead ≤ 3,000 lines (1 in flight + 1 in transform + 1 in encoder), no timers holding the generator, pool connection released between batches. Run T036 and T037 separately with `test-spec.sh`.
- [X] T040 [US2] Add the unit assertion of T018 (producer never passes FIFO-only options) next to `ORD/infra/export-queue.adapter.ts` and keep it green.

**Checkpoint**: US1 + US2 green; AS-12 benchmark exists (run in Phase 10).

---

## Phase 5: User Story 3 — Live and polled progress (P1)

**Goal**: throttled progress persisted and published; advisory channel; viewer policy.

### Tests first (red)

- [X] T041 [P] [US3] In `ORD/order-export-progress.e2e-spec.ts` write AS-15 (25,000 lines in its own `describe`/process batch, clock +1 s per batch, listener on `order-export:E`: 25 `progress` events with strictly increasing counters then one `done`; stored counters equal last event; progress not replayable, `done` replayable), AS-17 (failing publisher: export `DONE`, correct file, error log at most once a minute, `GET` true) and AS-19 (`RUNNING` read at 3,000/10,000, `expiresAt null`; download on `QUEUED|RUNNING|FAILED|CANCELLED` → `409 export_not_ready`, nothing signed).
- [X] T042 [P] [US3] Write AS-18 in the same file: `U`,`W` admitted; `V`, `X`, `N`, anonymous, removed member refused identically; terminal event replayed to a late subscriber; subscribing to `job:E` refused (no `job` prefix registered by orders).

### Implementation

- [X] T043 [US3] Add progress to `order-export-run.service.ts`: at each batch boundary use `shouldPublishProgress`; persist counters and publish `progress` (replay false) at the same cadence; `done` replay true; publishes through `EXPORT_LIVE` fire-and-forget with a once-per-minute error log; never inside a transaction (A11, FR-018, FR-019).
- [X] T044 [US3] Create `ORD/api/order-export-topics.ts` and `ORD/order-export-topics.module.ts`: `TopicRegistry.define({prefix: 'order-export', policy})` with an async policy calling `ShopAccessService.assertMember(job.shopId, userId, 'orders.manage')` after reading the job's shop by id; every refusal identical (A14). Register no `job:` prefix anywhere in `orders`.
- [X] T045 [US3] Run `order-export-progress.e2e-spec.ts` until green; update the living-spec page.

---

## Phase 6: User Story 4 — Idempotent, single, rate-limited start (P2)

### Tests first (red)

- [X] T046 [P] [US4] In `ORD/order-export.e2e-spec.ts` write AS-20 (replay: byte-identical stored body, `Location`, `Idempotency-Replayed: true`, one job/one message), AS-21 (`Promise.all` of two same-key requests: `202` + `409 idempotency_in_flight` + `Retry-After: 1`, third replays), AS-22 (key on `Sx` path → `422 idempotency_key_reuse`, no job), AS-23 (missing → `idempotency_key_required`; 7 chars, 129 chars, space → `idempotency_key_invalid`).
- [X] T047 [P] [US4] Write AS-24 (`Promise.all` of `U` and `W`, different keys: one `202`, one `409 export_already_active {activeExportId}`; third while active also 409; `S2` unaffected), AS-25 (after `DONE`/`FAILED`/`CANCELLED` the refused key `K2` creates a new export), AS-26 (sixth start in an hour `429 rate_limited` + `Retry-After`; limiter store down → refused, no job).

### Implementation

- [X] T048 [US4] Add `@Idempotent` (24 h, per user, path-compared) and `@RateLimit('orders.export-start.shop')` to the start route in `ORD/api/order-export.controller.ts`; add the policy `orders.export-start.shop` (5/h, subject shop, fail closed) to `ORD/rate-limit-policies.ts`; map the active-index unique violation to `409 export_already_active {activeExportId}` and make sure a pre-creation refusal stores nothing under the key (if the S54 interceptor caches non-2xx, record it in gaps.md "Sibling-spec follow-ups" — already listed for S54 — and make AS-25 pass without editing S54).
- [X] T049 [US4] Run the AS-20–AS-26 cases with `test-spec.sh` until green.

---

## Phase 7: User Story 5 — Access, shop gate, validation, list (P2)

### Tests first (red)

- [X] T050 [P] [US5] In `ORD/order-export.e2e-spec.ts` write AS-27 (five routes × anonymous / `N`,`X` / `V` / other shop's path with `E`; `401`, identical `404 shop_not_found`, `403 permission_denied`, `404 export_not_found` identical to unknown id; nothing changes), AS-28 (`W` lists/reads/downloads/cancels `U`'s export; removed `W` → `404 shop_not_found`), AS-29 (`SUSPENDED` 403 `shop_suspended`, `DELETING` 409 `shop_offboarding`, `DELETED` 404, no permission → 403 first).
- [X] T051 [P] [US5] Write AS-30 (malformed ids, unknown body property, non-object body, `limit` 0/101/abc, bad `status`, `cursor=garbage` → `invalid_cursor`), AS-31 (45 + 3 exports with ties, pages 20/20/5, `nextCursor null`, `status=DONE`, no `S2` items, parsed by `orderExportPageSchema`), AS-32 (`FAILED` read: generic message; no storage location, internal id, key, lease, history).

### Implementation

- [X] T052 [US5] Add `GET /shops/:shopId/order-exports` (keyset `createdAt desc, id desc`, opaque cursor, `limit` default 20 max 100, optional `status`) to the controller and `order-export-query.service.ts`; `export_not_found` for any id not in the path's shop.
- [X] T053 [US5] Verify every repository method has the shop in its predicate (grep `shopId` in `export-job.repository.ts`) and run T050–T051 green.

---

## Phase 8: User Story 6 — Failure, cancel, crash, duplicate delivery (P2)

### Tests first (red)

- [X] T054 [P] [US6] In `ORD/order-export-worker.e2e-spec.ts` write AS-33 (storage fails after 3,000 lines once: abort leaves no object/upload, `QUEUED attempt 1`, counters reset, history `RUNNING→QUEUED retry`, redelivery after 60 s ± 20 %, no event; second delivery `DONE attempt 2`, 5,000 lines once, one event), AS-34 (three failures: `FAILED storage_unavailable attempt 3`, exact generic message, no file, acked, one `FAILED` event + `failed {code}`, new export allowed), AS-36 (limit 10, 11 lines: `FAILED row_limit_exceeded`, `totalRows 11`, nothing written, acked), AS-37 (gated run, clock past 2 h: `FAILED timeout`, no retry, no file), AS-38 (stall past 60 s → abort → transient path). Fault tests clean up in `afterEach` (L-013).
- [X] T055 [P] [US6] Write AS-39 (cancel queued: `200 CANCELLED`, history actor `U`, one event; later message acked with no effect), AS-40 (cancel running paused after 3 batches: stops by next boundary, upload aborted, `cancelled {}` live event, no `done`, `rowsWritten` unchanged), AS-41 (cancel twice `200` unchanged; `DONE|FAILED|EXPIRED` → `409 export_not_cancellable`; `Promise.all` of two cancels → one history row, one event), AS-42 (cancel vs completion both orders).
- [X] T056 [P] [US6] Write AS-43 (two workers, same message, `Promise.all`: one claim, one file, one `DONE`, one event), AS-44 (finished states acked, unknown id acked with one warning, four invalid payloads incl. old `{kind:'export',jobId}` dead-lettered with no side effect, no import job touched), AS-45 (kill at batch 7, clock +6 min, recovery on `appA` and `appB` concurrently: requeued once; final file equals uninterrupted run; no partial visible), AS-46 (`QUEUED` > 2 min re-enqueued once; younger untouched), AS-47 (`RUNNING attempt 3` expired → `FAILED attempts_exhausted`, no message), AS-48 (shutdown mid-run: `QUEUED`, `attempt` restored, redelivery completes), AS-49 (30 min of clock with 60 s heartbeats, recovery every minute changes nothing), AS-50 (A loses lease, B claims; A's progress/counter/finish writes affect nothing; file has only B's bytes; no history by A).

### Implementation

- [X] T057 [US6] Extend `order-export-run.service.ts`: failure handling via `classify` (retry → release to `QUEUED` with reason `retry`, counters reset, re-enqueue with `delaySeconds` 60 ± 20 % ≤ 900, abort upload; terminal → `FAILED` with code and fixed message), row-limit check right after the count, run deadline and storage inactivity from config, cancel observation at each batch boundary and heartbeat via token-checked re-read plus `AbortController` on the in-flight `put`, lease heartbeat every 60 s, fenced completion (loser deletes its own attempt object), graceful release on shutdown restoring `attempt` (register with the graceful-shutdown registry), message handling table of AS-44.
- [X] T058 [US6] Add `cancel` to `order-export-command.service.ts` and `POST …/:exportId/cancel` to the controller: `QUEUED|RUNNING → CANCELLED` (actor = user, `finishedAt`, history, outbox in one transaction), repeat on `CANCELLED` `200` unchanged without a second history row, `DONE|FAILED|EXPIRED` → `409 export_not_cancellable`; live `cancelled {}` published after commit.
- [X] T059 [US6] Create `ORD/application/order-export-maintenance.service.ts` recovery part: expired `RUNNING` → `QUEUED` (reason `lease_expired`, counters reset) + enqueue, or `FAILED attempts_exhausted` at attempt 3 with no enqueue; `QUEUED` unclaimed > 2 min (by `updatedAt`) → one enqueue; delete leftover `attempt-*` objects other than `fileKey`; every step idempotent and non-throwing on the condition it repairs (L-016).
- [X] T060 [US6] Create `ORD/application/order-export.job-types.ts` (`declareJobType` ×3 — `orders.recover-stalled-exports`, `orders.expire-exports`, `orders.purge-exports` — with payload contract `{}` next to a `JobPayloads` augmentation; loaded by a side-effect import line in `ORD/index.ts` like `order.job-types`) and `ORD/infra/order-export.jobs.ts` (handlers + `upsertSchedule` every minute / 15 min / daily at boot; catch `InvalidScheduleError` and log as a start-up failure; if `JobsService.cancel` is used adapt to its discriminated result) — S49 follow-up. Register in `OrderExportWorkerModule`.
- [X] T061 [US6] Run `order-export-worker.e2e-spec.ts` (split into two invocations if a run has no summary line — L-008) until green; on 5 failures of one test write the blocker into `questions.md`.

---

## Phase 9: User Story 7 — Retention, shop events, clean cutover (P3)

### Tests first (red)

- [X] T062 [P] [US7] In `ORD/order-export-lifecycle.e2e-spec.ts` write AS-51 (`T−8d` `DONE` → `EXPIRED` with file deleted, `T−6d` untouched, `410 export_expired`, second run no change; storage refusing delete → stays `DONE`, logged, retried next run), AS-52 (finished > 90 d purged with history and leftover file, active untouched, two concurrent runs same state), AS-53 (`started` event: `QUEUED`/`RUNNING` → `CANCELLED` reason `shop_offboarding`, `DONE` and `S2` untouched, duplicate delivery same effect, `…_cancelled` ignored), AS-54 (`shop_deleted`: cancel active, delete files, rows, history of `S`; `S2` untouched; twice → same end state), AS-55 (late `started` after `deleted` no effect; `{shopId: 5}`, `{}`, unknown `version` dead-lettered).
- [X] T063 [P] [US7] Write AS-56 (old `POST /shops/S/exports/orders` and `GET /shops/S/exports/E` → `404` without alias; one message on `order-exports`, none on `catalog-imports`; `job:E` refused; a catalog-sync-only app has no export route and the import consumer has no `kind` branch), AS-58 (log capture on one full and one failed export: `requestId`/`traceId`, `exportId`, `shopId`; no title/SKU/amount/link/location; metrics exist for status, lines, bytes, duration, queue wait, retries by code, downloads; one audit line per download), AS-59 (boot with each bad config value → startup fails naming the key before traffic/consuming), AS-60 (one outbox row per `DONE|FAILED|CANCELLED` parsed by `orderExportEventSchemas`; none for retry/requeue/expiry/purge; trigger-forced rollback of the final update → no event, still `RUNNING`).
- [X] T064 [P] [US7] Write the static assertions inside `ORD/orders-boundary.e2e-spec.ts` (AS-57): barrel exports no `*Model`, no `OrderExportService`, no `ExportJobTopicsModule`; the pinned TRANSITIONAL allow-list loses `OrderExportService` and `ExportJobTopicsModule`; the new `ORD/**/order-export*` and `export-*` files contain no `sequelize.transaction`, no `Product`/`Shop`/`User`/`Payment` table or model, no import of `catalog-sync`; no `job:` registration in `orders`.

### Implementation

- [X] T065 [US7] Add expiry and purge to `order-export-maintenance.service.ts`: expiry deletes the file first and only then `DONE → EXPIRED` (reason `retention`), a refused delete leaves `DONE` and is retried; purge deletes finished rows older than 90 d with their history (and any leftover file first); `download` on `EXPIRED` → `410 export_expired`; wire handlers in `order-export.jobs.ts`.
- [X] T066 [US7] Create `ORD/infra/order-export.tenancy.consumers.ts`: two `Projector`s with `idempotency: 'inbox'` (pattern of `catalog-sync/infra/tenancy-events.consumer.ts`): `order-export-shop-offboarding` (`tenancy.shop_offboarding_started` → cancel active exports with reason `shop_offboarding`; `…_cancelled` ignored) and `order-export-shop-deleted` (cancel active, delete files, then rows and history in bounded chunks); strict payload schemas, invalid/unknown version → `PermanentError`; late `started` after `deleted` is a no-op. Register in `OrderExportWorkerModule`.
- [X] T067 [US7] Add startup config validation (`validateExportConfig`, T015) wired into the S54 config toolkit for the keys of contracts/async.md; the worker and core fail to start naming the key; add metrics (final status, lines, bytes, duration, queue wait, retries by code, downloads) and structured logs without row data (FR-037, AS-58).
- [X] T068 [US7] Run `order-export-lifecycle.e2e-spec.ts` until green (split by describe if needed, L-008).

---

## Phase 10: Removal, wiring and G-54

- [X] T069 Wire the apps: `apps/core/src/core.module.ts` (+ `OrderExportModule`), `apps/worker/src/worker.module.ts` (+ `OrderExportWorkerModule`; readiness fails while `queueExists('order-exports')` is false — L-002), `apps/sse-gateway/src/sse-gateway.module.ts` (replace `ExportJobTopicsModule` with `OrderExportTopicsModule`) (A17).
- [X] T070 Remove the old code (A1–A3, A14, D.8): delete `ORD/application/order-export.service.ts`, `ORD/api/realtime-topics.ts`, `ORD/realtime-topics.module.ts`; in `libs/domains/catalog-sync` delete the two export methods and `OrderExportService` import in `api/catalog-import.controller.ts`, `OrderExportService` from providers/exports in `catalog-import.module.ts`, the `kind` field and `kind:'export'` branch in `infra/catalog-import.worker.ts`, and the export case at `catalog-import.e2e-spec.ts:120-128` (its useful idea lives on as AS-04/AS-05). Touch only the export lines (S07 owns the rest). `grep -rn "@app/domains/orders" libs/domains/catalog-sync` returns nothing.
- [X] T071 Update the barrel `ORD/index.ts`: export only `OrderExportModule`, `OrderExportWorkerModule`, `OrderExportTopicsModule` (+ the job-types side-effect import); remove `OrderExportService` and `ExportJobTopicsModule`; shrink the allow-list in `ORD/orders-boundary.e2e-spec.ts` accordingly (D-8, S10 follow-up). Keep `ORD/orders-boundary.e2e-spec.ts:118` (no S54 T037 audit comments) green.
- [X] T072 Contract migration `migrations/2026101*-orders-export-contract.js` (separate file, after T070 removed every read): drop `kind`, `rows`, `error`, `objectKey` (A15). Verify with a grep that nothing in the tree references them.
- [X] T073 [P] G-54 / S53 follow-up: remove `SequelizeModule.forFeature([ShopMembership])` and the tenancy model import from `apps/projector/src/projector.module.ts:36,154`; grep that no `@InjectModel(ShopMembership)` is reachable from the projector module graph; if some module in that graph still needs membership, migrate it to `MembershipQueryService.getMembersByShopIds` (no model in an app composition, X.1). Start `apps/projector` standalone and confirm it reaches ready (L-018).
- [X] T074 [P] S05 follow-up: confirm `grep -n 'JOIN "Product"' ORD/` shows nothing for export code and `pnpm --dir packages/backend check:table-ownership --strict` has zero export findings for `orders`. The remaining `orders` findings (stock `UPDATE "Product"`, models) are S10/S11/S13's: list them under "Remaining after S12" in `gaps.md` (not fixed here).
- [X] T075 [P] S51 follow-up: grep proves no `job:` registration remains in `orders`; document the new topic `order-export:<exportId>` and events `progress|done|failed|cancelled` in the W04 bullet of gaps.md (already listed; confirm text matches).
- [X] T076 [P] S49 follow-up: confirm `declareJobType` contracts are in place for the three job types and that enqueue/`upsertSchedule` do not throw `UnknownJobTypeError` / `InvalidScheduleError` at boot of `apps/worker`.

---

## Phase 11: Polish, proofs and records

- [X] T077 Re-run every gaps.md item against the tree and tick it in a short table appended to `gaps.md` ("Status at end of S12"): A1–A24, B (D-6, D-7, D-8, D-10, D-12, D-15), C (each row: S12's closed, others listed), D steps 1–9. Every gaps item must map to a task: A1–A3→T070; A4→T048; A5→T006; A6→T033/T052/T058; A7→T022/T057; A8→T057; A9→T027/T039; A10→T012/T027; A11→T043; A12→T011/T019; A13→T059/T065; A14→T044; A15→T019/T020/T072; A16→T011–T015; A17→T069/T071; A18→T066/T022/T023; A19→T067; A20→T016/T017; A21→T004/T018; A22→T024–T063; A23→T038; A24→T015/T027.
- [X] T078 Sibling-spec follow-ups: confirm `gaps.md` "## Sibling-spec follow-ups" lists S07, S10, W04, S53/S03, S54 and the infrastructure-port bullet exactly as in this change; add any new one discovered (do not edit sibling specs).
- [X] T079 Ops artifacts (rule 2): confirm `quickstart.md` "Ops artifacts" and the five S12 rows in `specs/UNVERIFIED.md` (SC-001/AS-12, SC-003 100k part, SC-005, SC-007, edge origin/lifecycle) are present with status `not run`; add a row for any other SC no automated test proves. Never mark them verified.
- [X] T080 Debt register: set D-10 in `docs/work/architecture/debt-register.md` to `resolved (S12, S07)` only for the part verifiable here, with a note that S07's half is checked by its own capability; leave D-12 as is except the S12 share note.
- [X] T081 Static gates, from `packages/backend`: `pnpm exec tsc --noEmit -p tsconfig.json`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, and in `packages/contracts` its own `tsc`/lint; `python3 scripts/livespec/check.py`. Fix findings; list unrelated pre-existing ones.
- [X] T082 Runtime proofs by script (L-004, L-015, L-018, L-019): start `apps/core`, `apps/worker` (consumer started, three schedules upserted), `apps/sse-gateway` (topic `order-export` defined) and `apps/projector` each on its own and confirm ready; smoke `POST /api/shops/<S>/order-exports` → 202, watch progress, `GET …/download`; record the commands and result in quickstart §3.
- [X] T083 (deferred to the final checkpoint: `scripts/qa/fresh-run.sh --here`; warm-stack suite already green, see specs/deferred-checks.md) Empty-stack proof (L-012, L-006): run `scripts/qa/fresh-run.sh` and the whole capability suite once: the five e2e files + `order-export-backpressure.e2e-spec.ts`, `catalog-import.e2e-spec.ts`, `orders-boundary.e2e-spec.ts`, the four unit specs, each file as a fresh process; a file without a summary line is a crash (L-008). Report failures with test names; do not weaken assertions (L-003).
- [X] T084 Final report: counts, which scenarios are proven by which file, which Ops artifacts remain `not run`, which sibling follow-ups were written, and any blocker in `questions.md`.

---

## Dependencies & Order

- Phase 1 → Phase 2 (blocks all stories). T003 (living spec) before any code. T004 before any test that touches the queue.
- Inside Phase 2: contracts T006 ∥ unit specs T007–T010 → domain T011–T015; T016→T017; T019→T020/T021→T022→T023.
- US1 (Phase 3) is the MVP and the base for US2–US7. US2, US3, US4, US5 can proceed in parallel after US1 (different files except the shared `order-export.e2e-spec.ts` and `order-export-run.service.ts`: sequence edits to those). US6 follows US1 and US3 (progress/live events used by cancel/fail). US7 follows US6 (maintenance service shared).
- Phase 10 after US1–US7; T072 only after T070. Phase 11 last.
- Test-first pairs: T024–T026→T027–T035; T036–T037→T039; T041–T042→T043–T044; T046–T047→T048; T050–T051→T052; T054–T056→T057–T060; T062–T064→T065–T067; unit T007–T010→T011–T014; storage T016→T017.

## Parallel examples

- Foundational: T007, T008, T009, T010 together; then T011–T015 together.
- US1 tests: T024, T025, T026 (same file: write in separate `describe` blocks, merge sequentially); US1 infra: T028 ∥ T029 after T027's port.
- Phase 10: T073, T074, T075, T076 together.

## Implementation strategy

1. MVP = Phases 1–3 (US1): start, run, download for `F5` on the real stack.
2. Add US2 (streaming guarantees) and US3 (progress) — both P1 — then US4/US5 (P2 access and idempotency), US6 (failure/recovery), US7 (retention, tenancy events).
3. Cut over (Phase 10) only when the new path is green; old and new coexist until T070.
4. End with static gates, standalone app boots, empty-stack suite (Phase 11).
