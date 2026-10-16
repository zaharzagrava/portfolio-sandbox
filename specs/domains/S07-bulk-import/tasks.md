# Tasks: S07 — Bulk Catalog Import (domain `catalog-sync`)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults), `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, constitution v3.1.0.

**Tests**: Required (test-plan.md, 71 scenarios). Every code task is preceded by the failing test task that proves it (test-first). Each e2e file is run alone through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` from `packages/backend` (L-008); the whole suite only once, in the last phase. A test that fails 5 fix attempts → stop and write the blocker into `questions.md`.

**Paths**: `BE` = `packages/backend`, `D` = `packages/backend/libs/domains/catalog-sync`, `C` = `packages/contracts/src/catalog-sync`. `[P]` = different files, no dependency on an unfinished task.

**Rules that hold for every task**: no `git checkout/restore/reset/stash/clean` (undo by hand-editing only the named lines); no `*.reviewed.json` edit; no new direct `sequelize.transaction` (baseline 0, `.tx.baseline`) — use `TransactionRunner.run`; no `422 validation_failed` (DTO failures are `400 validation_failed`, S54); idempotency keys in tests ≥ 8 chars; each test creates its own shop/user/file (L-005/L-006); no "A or B" assertions (L-003); faults dropped in `afterEach` (L-013); cleanup paths tolerate "already gone" (L-016).

## Phase 1: Setup and living spec

- [X] T001 Run the real `pnpm --dir packages/backend check:table-ownership --strict` and `pnpm check:boundaries`; record the findings for `libs/domains/catalog-sync` in `specs/domains/S07-bulk-import/research.md` (gap-coverage section C) and reconcile against `.ownership.baseline` (1) — gaps C was reconstructed, not run
- [X] T002 Write the living-spec page `docs/spec/capabilities/S07-bulk-import.md` FIRST (rules + behaviors for FR-001…FR-046, the 8-state machine, `400 validation_failed` for DTO/query/cursor failures, `422 invalid_parts|size_mismatch|idempotency_key_*`, key shape 8–128 `[A-Za-z0-9_-]`, AS-70 read as "no longer served by catalog-sync", scanner checks in `libs/infrastructure/antivirus`); every `[proof:]`/`[code:]` true; run `python3 scripts/livespec/check.py`; do not touch any `*.reviewed.json`
- [X] T003 [P] Re-verify the already-done S12 removals so they cannot return: `rg -n "OrderExportService|kind: 'export'|kind:'export'" D` returns nothing in the import files; note result in `research.md`
- [X] T004 [P] Verify queue `catalog-imports` + DLQ are in `infra/docker/elasticmq.conf` and terraform `main.tf` (L-002/L-020/L-011); no queue is added, so no reload; write the result into quickstart.md "Prerequisites" only if it differs

---

## Phase 2: Foundational (blocks all stories)

**Purpose**: contracts, pure domain, schema, repository, ports, infrastructure additions.

### Contracts (A32, FR-046, Constitution V)

- [X] T005 [P] Write failing contract spec `C/imports.spec.ts`: parse/reject tables for `importStartRequestSchema`, `importStartResponseSchema`, `importUploadStateSchema`, `importCompleteRequestSchema`, `importJobSchema` (no `storageKey`, `uploadHandle`, lease, `cancelRequestedAt`, `lastEnqueuedAt`, `slot`), `importPageSchema`, `importErrorReportSchema`, `importProgressEventSchema`, `importEventSchemas` (`catalog_sync.import_finished` v1), the 10 failure codes and problem codes
- [X] T006 Implement `C/imports.ts` and export it from `C/index.ts` (zod; status enum of the 8 states; sizeBytes 1…5,368,709,120; `fileName` display ≤ 120; failure codes closed list from `contracts/http-api.md`); run `pnpm --dir packages/contracts` tsc + the spec from T005

### Pure domain, unit specs first (AS-15, 19, 26, 30, 31, 43, 48, 58)

- [X] T007 [P] Write failing `D/domain/import-status.spec.ts`: all 56 ordered pairs, exactly 13 allowed, exhaustive switch (`assertNever`), stale-`from` rule (AS-58)
- [X] T008 [P] Write failing `D/domain/import-row.spec.ts`: `it.each` over price (`"12.50"`, `"1e3"`, `" "`, `"true"`, `0`, negatives, >2 decimals), stock (empty cell keeps stock, `0` sets 0, absent column keeps), tags, field mapping to `ExternalProductInput` names (`externalSku`, `title`, `description`, `brand`, `category`, `priceMinor`, `quantity?`, `tags?`); `fast-check` exact decimal→minor-unit property (AS-15, AS-20)
- [X] T009 [P] Write failing `D/domain/import-sniff.spec.ts`: signatures (zip, gzip, pdf, exe, png…), UTF-8/UTF-16 BOMs, NUL bytes, invalid UTF-8, JSONL vs CSV by content not name (AS-26, AS-27)
- [X] T010 [P] Write failing `D/domain/import-batcher.spec.ts`: 500-item batches, flush before a repeated SKU so two calls never share a SKU in one batch, later row wins, `batchNumber = ceil(lastRow/500)`; a file-rule-failed row still counts as a record (AS-19)
- [X] T011 [P] Write failing `D/domain/error-report.spec.ts`: formula guard table (`= + - @ \t \r` prefixes), CSV round-trip property, columns `row,sku,field,code,message`, field mapping and message table pinned (a code with no message fails the test) (AS-30, AS-48)
- [X] T012 [P] Write failing `D/domain/file-name.spec.ts`: CRLF, traversal (`../`), 300 chars, dots only, control characters (AS-31)
- [X] T013 [P] Write failing `D/infra/import-pipeline.spec.ts`: blocked sink never pulls more than 500 + 16 records, resume delivers each exactly once in order, abort destroys every stage, CSV byte-offset property (AS-43)
- [X] T014 [P] Implement `D/domain/import-status.ts` (8 states, 13 transitions, reasons, `assertNever`) to pass T007
- [X] T015 [P] Implement `D/domain/import-row.ts` (exact decimal price, stock, tags, mapping; replaces `domain/rows.ts`) to pass T008
- [X] T016 [P] Implement `D/domain/import-sniff.ts` to pass T009
- [X] T017 [P] Implement `D/domain/import-batcher.ts` (500, flush-before-repeated-SKU) to pass T010
- [X] T018 [P] Implement `D/domain/error-report.ts` (line writer, formula guard, message table, field mapping) to pass T011
- [X] T019 [P] Implement `D/domain/file-name.ts` (display/download name, ≤ 120) to pass T012
- [X] T020 [P] Implement `D/domain/import-limits.ts` (defaults: 3 active/shop, 500 batch, 24 h upload expiry, error cap, 60 s scan inactivity, 30 min scan total; validated config shape)
- [X] T021 Implement `D/infra/import-parse-stage.ts` (csv-parse / JSONL line reader with offsets, 1 MiB record limit, abort-aware, object mode) and `D/infra/import-pipeline.ts` (`stream.pipeline` source → parser → batcher → writer with `AbortSignal`, backpressure bound) to pass T013 (A19, A20)

### Ports, migrations, repository

- [X] T022 [P] Create ports in `D/domain/ports/`: `import.repository.ts`, `import-storage.ts`, `import-catalog.gateway.ts` (`{externalSku,title,description,brand,category,priceMinor,quantity?,tags?}`), `import-queue.ts` (`enqueue` accepts `delaySeconds` only — never `groupId`, L-001), `import-shop-status.ts`; clock = existing `CLOCK` (D-6)
- [X] T023 Write failing repository e2e `D/infra/repositories/sequelize-import.repository.e2e-spec.ts`: conditional transition `UPDATE … WHERE status=:from` + history row in one transaction; stale `from` returns "lost"; cap (partial unique index on `("shopId","slot")`: 5 concurrent inserts → 3 win); one-run-per-shop index; lease claim/renew/fence (late commit refused, counters never decrease); checkpoint commit writes counters + `lastRow` + `nextByteOffset` + header + format together; keyset list `(createdAt DESC, id DESC)` with equal instants; every predicate carries `shopId`
- [X] T024 Write migrations `BE/migrations/2026101x-catalog-import-v2-expand.js` (columns of `data-model.md`, widen `status` CHECK to 8 values, `CHECK rowsProcessed = created+updated+unchanged+failed`, `sizeBytes` 1…5,368,709,120 CHECK, `ImportJobHistory`, indexes, `lock_timeout`), `…-data.js` (map legacy `error`→`failureCode`, `checkpointRow`→`lastRow`, `objectKey`→`storageKey`, `uploadId`→`uploadHandle`; legacy non-final rows older than 24 h → `EXPIRED`, others get slots; legacy `FAILED` → `failureCode='internal_error'`), `…-contract.js` (drop FKs to `Shop`/`User`, drop legacy `error`, `checkpointRow`, `objectKey`, `uploadId` after code stops reading them) (A25); never run at app start
- [X] T025 Register `ImportJobHistory` as `domain:catalog-sync` in `BE/db/ownership.ts` (handled events use the shared inbox, no new table) (L-011)
- [X] T026 Implement `D/infra/repositories/sequelize-import.repository.ts` (raw parameterised SQL on the two own tables only, `TransactionRunner.run`/`@Transactional`, no `@InjectConnection` outside `infra/`) to pass T023 (D-6, D-7)

### Infrastructure additions (shared)

- [X] T027 [P] Write failing storage spec for ranged `getStream(key, { start })` in `BE/libs/infrastructure/storage/` (in-memory and S3 adapters; start beyond end; stream destroyed on abort)
- [X] T028 Implement `ObjectStorage.getStream(key, { start })` in the port, in-memory and S3 adapters (additive; S12 reads unaffected) to pass T027 (A31)
- [X] T029 [P] Write failing cases in `BE/libs/infrastructure/antivirus/clamd-scanner.spec.ts`: quiet socket (inactivity deadline), total deadline, size-limit reply, empty/partial/garbage replies, chunk size, backpressure, socket always destroyed; `mode: 'active'|'disabled'` on the port (AS-25, AS-24)
- [X] T030 Implement `scan(..., { inactivityMs? })` and `mode` in `libs/infrastructure/antivirus` (additive; S29 media caller unaffected) to pass T029; extend the production-config validation so a missing scanner in production fails boot for imports too (A7, FR-009, AS-32)
- [X] T031 [P] Implement `D/infra/import-storage.adapter.ts`: keys `imports/<shopId>/<importId>/source` and `…/report/<batch>.csv|errors.csv`, ranged read, list parts, delete tolerant of "missing" (L-016), `put(..., {signal, inactivityTimeoutMs})` for report parts, `presignGet(key, {expiresInSec: 600, downloadName, contentType: 'text/csv; charset=utf-8', userContent: true})` (S12 adoption)
- [X] T032 [P] Implement `D/infra/import-catalog.adapter.ts` calling S05 `ProductImportService.upsertFromExternal` only (no `INSERT/UPDATE "Product"`, no `catalog.product_changed`) with a per-batch deadline; map its per-item rejections to `{row, field, code}` (A1, A2, D-12)
- [X] T033 [P] Implement `D/infra/import-queue.adapter.ts` (zod message `{importId}` strict; `delaySeconds` only) and a unit test asserting a `groupId` option is rejected at creation (L-001)
- [X] T034 [P] Declare job types in `D/infra/import.jobs.ts` (`declareJobType` with payload contract next to the `JobPayloads` augmentation, pattern of `offline-sync.jobs.ts`): `catalog-sync.recover-stalled-imports`, `catalog-sync.expire-pending-imports`, `catalog-sync.purge-imports`; catch `InvalidScheduleError`; never call `JobsService.cancel` (S49)
- [X] T035 Build test fixtures: `D/test/fakes/fake-clamd.ts` (clean, infected, refuse, stall, size-limit reply, garbage), `D/test/fakes/gated-storage.ts` (test releases bytes to freeze a worker at a batch), `D/test/fakes/recording-storage.ts` (range requested, stream `destroyed`), shared e2e harness helper booting `CatalogImportModule`, `CatalogImportWorkerModule`, projector and topics modules with tenancy, identity, catalog, outbox, limiter, realtime, scheduler, idempotency interceptor, production pipe/filter/prefix, frozen clock, per-test shop/user/file creation
- [X] T036 Add rate-limit policy `catalog-sync.import-start.shop` (10 per window) and remove `imports.concurrent` in `D/rate-limit-policies.ts`; drop any `@RateLimit`/`throttle`/`skipThrottle`/`SessionNotRevokedGuard` use in the import files (S01, S50)

**Checkpoint**: contracts, domain, schema, repository and fixtures green; `tsc --noEmit` clean.

---

## Phase 3: US1 — A seller imports a catalog from a file (P1) 🎯 MVP

**Goal**: start → upload parts → complete (202) → worker reads, writes via S05, DONE with counters.
**Independent test**: `import-upload` and `import-processing` e2e green.

### Tests first

- [X] T037 [US1] Write failing `D/import-upload.e2e-spec.ts` (`Bulk import upload API`): AS-01 start 201 + server-made key + open upload + expiry; AS-02 table over every validation class and both inclusive boundaries → `400 validation_failed`, nothing persisted; AS-03 replay of stored body; AS-04 `Promise.all` two identical starts → one 201, one 409; AS-05 different body `422 idempotency_key_reuse`, missing key `422 idempotency_key_required`, short key `422 idempotency_key_invalid`; AS-06 `GET …/upload` lists uploaded/missing, other state 409; AS-07 complete = 202 + `Location`, object size, `UPLOADED`, one message, no wait; AS-08 table of bad part lists → `422 invalid_parts`, stays `PENDING_UPLOAD`, no message; AS-09 short by 1 byte → `422 size_mismatch`, `FAILED`, object deleted, finished event; AS-10 replay → 200, no storage call, one message; AS-11 `Promise.all` complete → one 202, one 200, one message, one history row; AS-12 `CANCELLED`/`EXPIRED` → 409
- [X] T038 [US1] Write failing `D/import-processing.e2e-spec.ts` (`Bulk import processing`): AS-13 1,200 rows → `DONE`, 3 catalog calls of 500/500/200, counters, products via `ProductQueryService.getProductsByIds`, source deleted, finished event, live `done`; AS-14 BOM/CRLF/quoted newline/header case/extra column/blank line + JSONL parity; AS-16 missing/repeated required column → `FAILED invalid_header`, zero catalog calls; AS-17 re-import `rowsUnchanged: 1200`, versions unchanged, no new product events; AS-18 3 changed + 2 new; AS-19 same SKU twice, later wins, no error line, no two calls share a SKU; AS-20 empty stock cell keeps 5, `0` sets 0, absent column keeps

### Implementation

- [X] T039 [US1] Implement `D/application/import-start.service.ts`: `start` (one `TransactionRunner.run`: per-shop lock + cap + insert + history; code-called `limiter.check('catalog-sync.import-start.shop', shopId)` before the create; shop status gate; sanitised name; server-made key; initiate multipart outside the transaction, store handle), `upload` state, `complete` (validate parts and assembled size, conditional `PENDING_UPLOAD→UPLOADED|FAILED`, enqueue after commit with `lastEnqueuedAt`, replay → 200), returning `{job, created}` (A9, A10, A11; no I/O in transactions)
- [X] T040 [US1] Rewrite `D/api/catalog-import.controller.ts`: routes `POST /shops/:shopId/imports` (`Idempotent()`, 201/200/409), `GET …/:importId/upload`, `POST …/:importId/complete` (202 + `Location`), uses `ShopScoped`, `ParseUUIDPipe`, house `ZodPipe` with schemas from `@contracts`; response DTOs only; one call per method (II.1); no `throttle`/`skipThrottle`/`SessionNotRevokedGuard`
- [X] T041 [US1] Implement `D/application/import-runner.service.ts` (happy path): claim lease → `SCANNING`→`PROCESSING`, sniff + header validation (FR-017), `pipeline` from `nextByteOffset`, 500-item batches through `ImportCatalogGateway`, per-batch commit of counters + checkpoint under the fence, progress publish after commit, `DONE`, delete source, file-rule and catalog refusals recorded as row errors (counted, not thrown)
- [X] T042 [US1] Implement `D/infra/import.consumer.ts` (zod-validated `{importId}`, delivery count, heartbeat, malformed → reject without side effect) and `D/application/import-events.ts` (`catalog_sync.import_finished` v1 via `outbox.append` in the transition transaction; `import:<id>` progress `replay:false`, terminal `replay:true`)
- [X] T043 [US1] Create the modules in `D/catalog-import.module.ts`: `CatalogImportModule` (HTTP), `CatalogImportWorkerModule` (consumer + 3 jobs; imports `TenancyModule`, `ProductModule`, `AntivirusModule`, `IdempotencyModule`, clock, outbox/events, `JobsModule` itself, L-018), `CatalogImportProjectorModule`; keep `RateLimitModule.forRoot()` in the HTTP apps; run T037 and T038 until green

**Checkpoint**: US1 independently green.

---

## Phase 4: US2 — Uploaded files are untrusted (P1)

**Goal**: fail-closed scan, sniffing, safe delivery.
**Independent test**: `import-security` e2e.

- [X] T044 [US2] Write failing `D/import-security.e2e-spec.ts` (`Bulk import file security`) with the fake scanner: AS-21 clean scan `SCANNING→PROCESSING`, verdict stored, buffered bytes bounded; AS-22 EICAR → `FAILED malware_detected`, file deleted, no catalog call, finished + live `failed` events, signature only in logs; AS-23 refusing scanner (forces fallback, gate 9): deliveries 1–2 stay `SCANNING`, third `FAILED scan_unavailable`, DLQ; AS-24 stall past 60 s (clock moved) abandoned + socket closed, slow-but-progressing scan completes; AS-26 zip renamed `.csv` → `FAILED unsupported_file_type`, file deleted; AS-27 JSONL named `.csv` and CSV named `.jsonl` both `DONE`, traversal name leaves keys unchanged; AS-28 2 MiB JSONL line → row error and continue, unterminated CSV quote → `FAILED malformed_file` with flat memory; AS-32 boot with production settings and no scanner fails, non-production explicit disable records `scan: 'skipped'`
- [X] T045 [US2] Implement in `import-runner.service.ts` + `D/infra/import-scanner.adapter.ts`: scan step through the shared `MalwareScanner` (`@app/infrastructure/antivirus`), fail-closed, inactivity/total deadlines, delivery-budget (≤ 3) mapping to `scan_unavailable`, infected/unsupported → delete source, failure codes with generic detail only, signature only in logs
- [X] T046 [US2] Delete the shim `D/infra/clamav.ts` and `D/infra/clamav.spec.ts`; no import of `infra/clamav` remains (S29, D-6); run T044 until green

---

## Phase 5: US3 — Imports survive crashes, restarts and doubled workers (P1)

**Goal**: checkpoints, lease fencing, resume by byte offset, recovery.
**Independent test**: `import-resilience` e2e.

- [X] T047 [US3] Write failing `D/import-resilience.e2e-spec.ts` (`Bulk import resilience`): AS-33 stop after batch 3 (gated stream), row holds counters/`lastRow`/`nextByteOffset`/header/format together, progress after commit; AS-34 redelivery reads from `nextByteOffset` (range observed), no rescan, no row ≤ `lastRow` sent, final equals clean run; AS-35 trigger fault between catalog write and checkpoint → batch 4 re-sent, counters within one-batch bound, products equal; AS-36 `Promise.all` of two deliveries → one runs; AS-37 lease expired by the clock, B resumes, A's late commit refused, counters never decrease; AS-38 redelivery on `DONE|FAILED|CANCELLED|EXPIRED` → no read/call/event; AS-39 shutdown mid-batch → consistent checkpoint, streams and sockets destroyed, lease released, `PROCESSING`, within 10 s; AS-40 recovery re-enqueues lost-message and expired-lease jobs once, fresh/live untouched, two instances; AS-41 table of bad messages (non-JSON, missing, non-UUID, unknown job, extra fields) → no side effect, log with `messageId`; AS-42 break after 700 rows → `FAILED malformed_file`, streams `destroyed`, first 500 kept; AS-44 statement-timeout trigger (forces fallback, gate 9): second delivery completes, persistent → `FAILED internal_error`, DLQ, no SQL in body; AS-45 `SUSPENDED` before and during → `FAILED shop_not_active`, no retry, failing batch not written; AS-46 error cap 5 → `FAILED too_many_errors`, later rows not read; AS-71 object removed → `FAILED source_missing`, no retry, event
- [X] T048 [US3] Implement in the repository/runner: lease claim/renew heartbeat/fence on every commit, resume from `nextByteOffset` with stored header/format, no rescan after `scan='clean'`, redelivery on final states = no-op, shutdown hook aborting at a batch boundary and releasing the lease (A14, A16, A17, A20)
- [X] T049 [US3] Implement failure mapping in the runner: transient errors → rethrow within the delivery budget (≤ 3, one retry layer) then `FAILED internal_error` (generic message, never raw exception text), permanent (`source_missing`, `shop_not_active`, `invalid_header`, `malformed_file`, `too_many_errors`) → no retry; shop-status check before each batch via `ImportShopStatusPort` (R1) (A18, A22)
- [X] T050 [US3] Implement `import-lifecycle.service.ts` recovery and the `catalog-sync.recover-stalled-imports` handler in `import.jobs.ts` (single-run `concurrency:1, fleetConcurrency:1`, idempotent, window from `lastEnqueuedAt`) (A21); run T047 until green

---

## Phase 6: US4 — The seller learns which rows were refused (P2)

**Independent test**: `import-report` e2e.

- [X] T051 [US4] Write failing `D/import-report.e2e-spec.ts` (`Bulk import error report`): AS-29 URL on the user-content origin, 10-minute expiry, attachment disposition (RFC 6266), `text/csv`, no route links the source file; AS-47 10,000 rows with 3 bad (one row with two problems), header, order, `row` ordinals, 20 progress events; AS-48 price `0`, 201-char title, long SKU show the catalog's code and mapped field, neighbours imported; AS-49 bad rows before and after a crash each appear once, `rowsFailed: 3`; AS-50 `409` while processing, `404` with no failures, lines so far when `FAILED`/`CANCELLED`, `404` after retention
- [X] T052 [US4] Implement batch-keyed report parts (`report/<batch>.csv`, overwritten idempotently on redelivery) in the runner and finalisation into `errors.csv` with header; `errorReportKey`/`errorReportRows`; delivery via `import-query.service.ts` `errorReport` + controller `GET …/error-report` returning `importErrorReportSchema` with a fresh presigned URL only on this route (A15, A12); run T051 until green

---

## Phase 7: US5 — Seller and team follow, list and cancel (P2)

**Independent test**: `import-status` e2e.

- [X] T053 [US5] Write failing `D/import-status.e2e-spec.ts` (`Bulk import status, progress and cancel`): AS-51 `importJobSchema`, no key/handle/URL/lease/signature; AS-52 every route × (member of another shop, non-member) → identical `404` bodies, nothing changes, list isolated; AS-53 `401` per route, read-only role `403` on writes, malformed IDs `400` with zero statements; AS-54 45 jobs with equal instants → pages 20/20/5, no repeat/gap, filters, bad limit/status/cursor `400 validation_failed`; AS-55 subscribed member gets progress, terminal events replayable, non-member and removed creator refused, status route agrees; AS-56 cancel from each non-final state, running job stops at next safe point, writes kept, upload aborted, final-state `409`, repeat `200`; AS-57 `Promise.all` cancel vs complete → one transition, loser `409`; AS-59 25-hour job expires with upload aborted + event, 23-hour untouched, idempotent, two instances
- [X] T054 [US5] Implement `D/application/import-query.service.ts` (`status`, keyset `list` with opaque cursor and filters), `cancel` in `import-start.service.ts` (conditional transition; `cancelRequestedAt` for `SCANNING|PROCESSING`; abort upload; runner honours it at the batch boundary), controller routes `GET …/imports`, `GET …/:importId`, `POST …/:importId/cancel`
- [X] T055 [US5] Rewrite `D/api/realtime-topics.ts` with an asynchronous R1 `ShopAccessService.assertMember` policy (no raw table read), prefix `import` only (no `job:`), terminal events `replay:true`; update `D/realtime-topics.module.ts` (`ImportJobTopicsModule` + `TenancyModule`) and `apps/sse-gateway` registration (S51, A24)
- [X] T056 [US5] Implement the expiry handler `catalog-sync.expire-pending-imports` in `import.jobs.ts` + `import-lifecycle.service.ts` (24 h, abort upload, finished event, idempotent); run T053 until green

---

## Phase 8: US6 — One shop's huge import never starves others (P2)

**Independent test**: `import-fairness` e2e.

- [X] T057 [US6] Write failing `D/import-fairness.e2e-spec.ts` (`Bulk import fairness and limits`): AS-60 gated `J1` of shop A, `J3` of shop B completes, `J2` handed back with 60 s ± 20% delay, status unchanged, no delivery budget spent; AS-61 five concurrent starts → exactly 3 `201`, 2 `409`, terminal jobs don't count; AS-62 11th start `429` + `Retry-After`; limiter store down → `503` and reads fine (forces fallback, gate 9); AS-63 `SUSPENDED` → `403`, `DELETING` → `409`, reads `200`
- [X] T058 [US6] Implement hand-back with jitter when another job of the shop holds the run slot (`ImportQueue.enqueue({delaySeconds})`, delivery budget not spent), the cap error → `409`, limiter failure → `503` (fail-closed on starts only), shop-status gate on writes; run T057 until green

---

## Phase 9: US7 — Imports follow the life of the shop and announce completion (P3)

**Independent test**: `import-lifecycle` and `import-boundary` e2e.

- [X] T059 [US7] Write failing `D/import-lifecycle.e2e-spec.ts` (`Bulk import lifecycle and events`): AS-64 one outbox row per final job in the same transaction, `importEventSchemas`-valid, none on redelivery, outbox fault trigger rolls status back; AS-65 `tenancy.shop_offboarding_started` cancels non-final jobs only for that shop, duplicate + invalid payloads, `shop_offboarding_cancelled` ignored; AS-66 `tenancy.shop_deleted` purges rows, history and objects, repeat/reorder safe, storage failure mid-purge retried; AS-67 retention (31/91/10-day, old non-final untouched, report-only vs full purge, cap 500, idempotent, two instances); AS-68 logs carry `importId`/`shopId`/`requestId` and no row data or URLs, metrics for rows by outcome, jobs by status, durations; AS-70 app with only this domain's modules answers `404` on both export routes, queue messages carry only `importId`
- [X] T060 [US7] Implement `D/infra/import-lifecycle.consumers.ts` (`catalog-sync-import-offboarding` with `inbox` idempotency, `catalog-sync-import-shop-deleted` `natural`; zod-validated, poison → `PermanentError`), registered in `CatalogImportProjectorModule`; `apps/projector` imports it
- [X] T061 [US7] Implement purge handler `catalog-sync.purge-imports` (report 30 days after `finishedAt` clearing `errorReportKey`; record + history 90 days; ≤ 500 per run, oldest first; delete tolerant of "already gone"), shop-deletion purge of `imports/<shopId>/`
- [X] T062 [US7] Implement `D/application/import-metrics.ts` and structured log fields (A28); register `catalog_sync.import_finished` once on topic `catalog-sync.events` with `TopicRegistry` (no second topic definition); run T059 until green
- [X] T063 [US7] Write failing `D/import-boundary.e2e-spec.ts` (`Catalog-sync import module boundary`): AS-69 `check:table-ownership --strict` and `check:boundaries` zero for the import files, no foreign keys on the import tables, `index.ts` exports no model, no `throttle|skipThrottle|SessionNotRevokedGuard|sequelize.transaction|INSERT INTO "Product"|INSERT INTO "Outbox"|imports.concurrent|infra/clamav|job:|kind` in the import files
- [X] T064 [US7] Removal and wiring (A1, A2, A27, A30, D-6/7/8/10/12): delete `application/catalog-import.service.ts`, `domain/rows.ts` (+ spec), `infra/catalog-import.worker.ts`, `catalog-import.e2e-spec.ts` (its scenarios live on as AS-47, AS-34, AS-26 — L-017), `imports.concurrent` leftovers; `D/index.ts` exports only `CatalogImportModule`, `CatalogImportWorkerModule`, `CatalogImportProjectorModule`, `ImportJobTopicsModule` (+ existing S08/S09 modules and `catalogSyncRatePolicies`), no model; update `apps/{core,worker,projector,sse-gateway,local-monolith}` wiring; run the contract migration (T024) only now; run T063 until green

---

## Phase 10: Polish, gates and final checkpoint (scripted, L-019)

- [X] T065 [P] Write `BE/scripts/bench/catalog-import-bench.ts` (generates a 1,000,000-row/5 GiB-class file, runs the real pipeline against MinIO and the real catalog, records throughput, peak RSS, per-shop start/finish with `--shops 20`, progress event timestamps) and `BE/scripts/bench/catalog-import-kill-loop.ts` (50 random kills of a 100,000-row import, compares with an uninterrupted run) — scripts only; do not run or claim results (SC-001, SC-002, SC-003, SC-006)
- [X] T066 (written; BLOCKED as `fixme` because W04 does not exist, SC-008 stays `not run`) [P] Write the Playwright happy path `packages/web/tests/seller-import.spec.ts` (choose CSV → parts upload → progress bar → `DONE` → report link downloads); subscribe to `import:<id>`; if the W04 page does not exist, mark it blocked and keep the SC-008 row in UNVERIFIED (never pass it silently)
- [X] T067 Confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-002, SC-003, SC-006, SC-008, AS-29 edge (`nosniff`), FR-044 storage rules, and `specs/UNVERIFIED.md` has one `not run` row each (rows already present — add only any that T065/T066 reveal); fill in "Execution record" with dates and `test-spec.sh` log paths of the green runs
- [X] T068 Complete `gaps.md`: tick/annotate every item A1–A32, B (D-6, D-7, D-8, D-10, D-12), C and D; keep "## Spec changes" (400 vs 422, key shape, AS-70, AS-25 location, deadlines) and "## Sibling-spec follow-ups" (S05, S29, S12, S51, S53, S54, W04, J04, S03, S08/S09) accurate; update debt-register rows D-6, D-7, D-8, D-10, D-12 for this domain in `docs/work/architecture/debt-register.md`
- [X] T069 Static gates: `pnpm --dir packages/backend exec tsc --noEmit`; ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (import files 0, domain total ≤ `.ownership.baseline`); transaction count of direct `sequelize.transaction` in the domain stays 0; `python3 scripts/livespec/check.py`
- [X] T070 Old behavior is gone: `rg -n "INSERT INTO \"Product\"|INSERT INTO \"Outbox\"|kind: 'import'|imports.concurrent|infra/clamav|job:" D` returns nothing for the import files
- [X] T071 (green except S08 `integration-boundary` AS-80 barrel list, a sibling follow-up in gaps.md) Whole capability suite once: `scripts/sdd/test-spec.sh libs/domains/catalog-sync/import-` (per-file fresh processes, each must print its summary line, L-008), then S08/S09 regressions `integration-boundary` and `sync-access`, plus the contracts and storage/antivirus specs
- [X] (deferred to the final checkpoint: `scripts/sdd/checkpoints/final.sh` runs `boot-app.sh core|projector|worker` and `fresh-run.sh --here`; L-019) T072 Runtime proofs by script (L-004, L-015, L-018, L-019): boot `apps/core`, `apps/worker`, `apps/projector`, `apps/sse-gateway` each on its own and `apps/local-monolith`; with a real session call `POST /api/shops/:id/imports` with a key, upload a part, complete, watch the job reach `DONE` and `import:<id>` events on the gateway; empty-stack run via `scripts/qa/fresh-run.sh` (L-012); browser suite once on an empty stack (L-006) if T066 is unblocked

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (T005→T006 contracts; T007-T013 before T014-T021; T023→T024→T025→T026; T027→T028; T029→T030; T035 before any e2e) → stories.
- US1 (Phase 3) is the MVP and the base for the others (they reuse its services, runner and modules). US2 and US3 extend the runner (sequential after US1). US4 follows US3's checkpointing. US5, US6, US7 need US1; US5/US6 can run in parallel with each other once US3 is done; US7 last (it removes the old code and runs the contract migration).
- Within a story: failing test task → code tasks → run the test green.
- Phase 10 after all stories; T071 then T072 are last.

## Parallel opportunities

- Phase 2: T007–T013 (all unit specs) together; T014–T020 together; T022, T027, T029, T031–T034 together.
- Phase 10: T065 and T066 together.
- Different e2e files may be written in parallel (T044, T047, T051, T053, T057, T059) but are *run* one file at a time.

## Implementation strategy

MVP = Phases 1–3 (living spec, contracts, domain, schema, upload API, happy-path processing). Then US2 (security, still P1), US3 (resilience, P1), then P2 stories, then P3, then the scripted final checkpoint. Do not run the whole suite until T071.

## Follow-up coverage (from built specs)

S01 → T036/T040/T063; S05 → T032/T063; S08 → T034/T062; S12 (removals, storage) → T003/T031/T064; S29 → T030/T046; S49 → T034; S50 → T036/T039/T058; S51 → T042/T055; S53 → T042/T062; S54 → T002/T037/T053.
