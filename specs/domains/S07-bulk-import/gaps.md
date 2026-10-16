# Gaps: S07 — current `catalog-sync` import code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/` unless stated; line numbers are those read on 2026-10-05. **Check not run:** `pnpm --dir packages/backend check:table-ownership` (and the same script run directly with `node -r ts-node/register`) needs an approval an unattended session cannot get, so section C is reconstructed from searches over `libs/domains/catalog-sync/` (every use of `"Product"`, `"Outbox"`, `ProductModel`, `ShopModel`, `@InjectConnection`, and every import of another domain's entry point). Run the real check first and reconcile. Integrations (`integrations*`, `integration-sync.service.ts`) and offline sync (`sync*`) belong to S08/S09; their lines are listed in section C only so the whole domain's check output can be matched, and are not S07's to fix.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Products are written with raw `INSERT … ON CONFLICT` into the product table, with `sellerId` set from the creator, `rating` and `tags` defaults, and no change detection; two rows with the same SKU in one statement make the database raise "cannot affect row a second time" and fail the whole job | `application/catalog-import.service.ts:188-215` | FR-020, AS-19, AS-69 |
| A2 | Raw outbox rows `{productId}` on the products topic, written by this domain (`KafkaTopicGroup.PRODUCTS_EVENTS`) | `application/catalog-import.service.ts:216-221`, import at `:12` | FR-020, S05 FR-042; replaced by the catalog's own events |
| A3 | Batch is 1,000 rows, above S05's 500-item limit | `application/catalog-import.service.ts:20,162` | FR-020, AS-13 |
| A4 | Row rules duplicate the product rules (`sku` ≤ 100, `title` ≤ 200, `description` ≤ 10,000, price regex with `0` allowed, `stock` required, `brand` ≤ 60, `category` ≤ 60) and use zod coercion with `z.coerce.number()` (accepts `"1e3"`, `" "`, `true`) | `domain/rows.ts:9-24` | FR-017–FR-019, AS-15, AS-48 |
| A5 | Content sniffing is "NUL byte = binary, `{` = JSONL, else CSV": no magic numbers, no encoding check, UTF-16 only caught by accident (NUL bytes) | `domain/rows.ts:27-31`; `application/catalog-import.service.ts:124-126` | FR-011, AS-26 |
| A6 | No header validation; a wrong header produces one row error per row | `application/catalog-import.service.ts:173-186` (`columns: true`) | FR-017, AS-16 |
| A7 | Scanner is skipped when `CLAMAV_HOST` is unset (no production guard); `scanStream` has one flat 120 s socket timeout (cuts off a long scan, never detects a stall on a quiet socket), does not destroy the socket on error or on a failed reply, treats any non-OK, non-FOUND text as an unexpected error but the job does not retry (the generic catch marks `FAILED`) | `application/catalog-import.service.ts:114-122`; `infra/clamav.ts:14-39`; `libs/common/config/api-config.service.ts:409` | FR-008–FR-010, AS-21–AS-25, AS-32 |
| A8 | Infected file is kept in storage; source files are never deleted after a final state | `application/catalog-import.service.ts:121,168` | FR-044, AS-13, AS-22 |
| A9 | `complete` trusts the client: no check of the part list, no check of the assembled size, check-then-act on `status` (two calls can both enqueue), `200 {status}` instead of `202 + Location` | `application/catalog-import.service.ts:67-74`; `api/catalog-import.controller.ts:34-37` | FR-006, AS-07–AS-12 |
| A10 | `start` is not idempotent (no key), has no cap or rate limit, stores the client's file name unsanitised (only `slice(0, 200)`), writes the job in two statements outside a transaction (a crash leaves `objectKey = 'pending/…'` and no upload), and returns the storage port's object (key, upload handle) to the client; validation is `class-validator` and the size error text is `'1 byte - 5 GB'` | `application/catalog-import.service.ts:54-65`; `api/catalog-import.controller.ts:11-24,31-33` | FR-001–FR-004, AS-01–AS-05, AS-31, AS-61, AS-62 |
| A11 | No resumable-upload route (a lost tab loses the part ETags) | `api/catalog-import.controller.ts` (absent) | FR-005, AS-06 |
| A12 | `status` returns `...job` (storage key, upload handle, counters) plus a presigned report URL minted on every poll, runs two queries, returns no `bytesProcessed`, `failure`, history or report info; response is not a contracts schema | `application/catalog-import.service.ts:76-87,247-255`; `api/catalog-import.controller.ts:40-43` | FR-033, AS-29, AS-51 |
| A13 | No list, cancel, expiry, or upload-state routes; status set is 6 states with a free-form `UPDATE … SET status`, no conditional `from`, no history | `application/catalog-import.service.ts:243-245`; `migrations/20261002100000-catalog-import.js:18` | FR-034, FR-036, FR-037, AS-54, AS-56–AS-59 |
| A14 | Checkpoint is `checkpointRow` only; resume re-parses the whole file from byte 0 and skips rows; counters and checkpoint are written in a statement separate from the product write and not guarded by a lease | `application/catalog-import.service.ts:151,158-162` | FR-023, FR-024, AS-33–AS-35 |
| A15 | Error report is one object streamed from a `PassThrough` and re-created on every run, so after a crash it contains only post-checkpoint failures (DOUBTS Q60); columns are `row,sku,error`; no formula-injection guard; echoed SKU is raw | `application/catalog-import.service.ts:128-131,166`; the SD-27 note "Caveat" | FR-014, FR-031, AS-30, AS-47, AS-49 |
| A16 | No per-job lease or fencing: concurrency is a per-shop limiter slot (`imports.concurrent`) acquired inside `process`, so two deliveries of one job can interleave when the slot is released or expired, and a stalled worker keeps writing; `ShopBusyError` is thrown after the job row was read and the consumer re-enqueues with a fixed 60 s delay (no jitter) | `application/catalog-import.service.ts:97-111`; `infra/catalog-import.worker.ts:31-36` | FR-025, FR-038, AS-36, AS-37, AS-60 |
| A17 | Finished jobs are ignored only for `DONE`, `FAILED`, `PENDING_UPLOAD` (no `CANCELLED`/`EXPIRED`); a missing job returns `'MISSING'` and the message is acknowledged | `application/catalog-import.service.ts:99` | FR-026, AS-38, AS-41 |
| A18 | Failure handling: any error marks the job `FAILED` with the raw exception text (`error.message.slice(0, 500)`, may contain SQL or a stack fragment) and rethrows, so the queue retries a `FAILED` job (which then returns at once); no retry budget, no failure codes | `application/catalog-import.service.ts:104-110,237-241` | FR-029, AS-44 |
| A19 | The pipeline uses `source.pipe(parse(...))` for CSV (no error propagation, source not destroyed on a parser error) and a bare `readline` for JSONL (no line-length limit, invalid lines become `{__invalid}` rows); no abort handling inside the parser | `application/catalog-import.service.ts:173-186,158-162` | FR-012, FR-015, AS-28, AS-42, AS-43 |
| A20 | Abort on shutdown throws `'aborted'` out of the loop without closing the source stream, the error stream or the open upload | `application/catalog-import.service.ts:158-159,107` | FR-027, AS-39 |
| A21 | No recovery of lost messages (job `UPLOADED` with nothing on the queue stays so forever), no expiry of abandoned uploads (relies on a storage rule only), no purge | absent; `SqsModule`/scheduler not used | FR-007, FR-028, FR-043, AS-40, AS-59, AS-67 |
| A22 | Shop status never consulted: a suspended or deleting shop's imports run on; no cap on failed rows | `application/catalog-import.service.ts` (absent) | FR-022, FR-030, FR-040, AS-45, AS-46, AS-63 |
| A23 | No terminal event; progress published with `{replay: false}` only and `done`/`failed` are not marked replayable; payload `{processed, failed}` | `application/catalog-import.service.ts:154,169,239` | FR-035, FR-041, AS-55, AS-64 |
| A24 | Live-channel policy is creator-only and reads the import table with a raw query; prefix `job` is shared with orders' export | `api/realtime-topics.ts:16-27` | FR-035, AS-55 |
| A25 | `ImportJob` has foreign keys to `Shop` and `User`; no table for history; `status` check has 6 values; no columns for byte offset, counters, format, header, lease, scan or failure code | `migrations/20261002100000-catalog-import.js:14-31` | Key Entities, AS-58, AS-69 (IX.4) |
| A26 | No shop-offboarding or deletion reaction (tenancy events not consumed) | absent | FR-042, AS-65, AS-66 |
| A27 | Order export is served by this domain's controller, module and worker (`OrderExportService`, `kind: 'export'`, queue `catalog-imports` shared) | `api/catalog-import.controller.ts:8,27-30,49-60`; `catalog-import.module.ts:8,10`; `infra/catalog-import.worker.ts:4,29` | FR-045, AS-70 (D-10, S12) |
| A28 | No metrics, no `importId`/`shopId` log fields; `Logger` created but unused | `application/catalog-import.service.ts:41` | FR-045, AS-68 |
| A29 | The e2e suite never calls the HTTP routes (it calls `imports.process` and `imports.status` directly), reads `"Product"` with raw SQL, imports `ShopModel` from tenancy, covers only 4 cases, has no 401/403/IDOR/idempotency/concurrency/consumer tests, and its progress assertion expects 10 events for 10k rows | `catalog-import.e2e-spec.ts:13,41,79,96,111-118` | VII.2, VII.3, VII.4, test-plan.md |
| A30 | The module registers `CatalogImportWorker` and the services in one provider list shared by the HTTP and worker modules; there is no projector module; `index.ts` exports transitional models for other domains | `catalog-import.module.ts:10,13-19`; `index.ts:5-10` | Cross-capability contracts (Provides: four modules) |
| A31 | Storage port lacks ranged read, list-parts and a user-content presign; queue port is adequate (delay, heartbeat, delivery count) | `libs/infrastructure/storage/object-storage.port.ts:29-45` | FR-005, FR-013, FR-023, AS-06, AS-29, AS-34 |
| A32 | Contracts package has no import schemas (`packages/contracts`); controller DTOs are `class-validator` classes | `api/catalog-import.controller.ts:11-24` | FR-046, V.2 |

## B. Open debt-register rows naming `catalog-sync` or S07

| Row | Debt | Replaced by | Where in this spec |
|---|---|---|---|
| D-10 | Order export routes and the `kind: 'export'` worker branch still live in catalog-sync; orders duplicates the queue name (`EXPORT_QUEUE = 'catalog-imports'`, `libs/domains/orders/application/order-export.service.ts`) | S12 owns routes, job and its own queue; S07 deletes its export controller methods, the `OrderExportService` import and the `kind` branch (X.5: removes the edge `catalog-sync → orders`) | FR-045, AS-70, A27 |
| D-7 | Other domains import `*Model` exports | For this domain's import files: the e2e's `ShopModel` import goes (use the tenancy fixture helper or its exported service); `index.ts` stops exporting models; the realtime policy uses R1 `ShopAccessService.assertMember` instead of querying a membership table | A29, A30, A24 |
| D-12 | Raw SQL on tables owned by another domain | The product and outbox statements are replaced by R1 `upsertFromExternal` and `outbox.append` (see C) | A1, A2 |
| D-6 | `api/` and `application/` import `infra/` directly (open, every capability) | The new code uses ports in `domain/` (`ImportRepository`, `ImportStorage`, `UploadScanner`, `ImportQueue`) with adapters in `infra/`; `application/catalog-import.service.ts:14` currently imports `../infra/clamav` | A7 |
| D-8 | Barrels export infrastructure internals (apps wire projectors directly) | `index.ts` exports the four modules named in Provides; apps import `CatalogImportWorkerModule` and `CatalogImportProjectorModule` rather than classes | A30 |

No other open row of `docs/work/architecture/debt-register.md` names `catalog-sync` or S07 (searched `catalog-sync`, `catalog-import`, `S07`: one hit, D-10).

## C. `pnpm check:table-ownership` lines for this domain (reconstructed; run the real check and reconcile)

`db/ownership.ts:70` registers `ImportJob` to `domain:catalog-sync` (correct). `ExportJob` is `domain:orders` (`:90`), so the migration's creation of it under this file's name is registry-correct but the code reference is cross-domain (see D-10).

| Kind | Where | What | IX.7 mechanism that replaces it |
|---|---|---|---|
| SQL | `application/catalog-import.service.ts:192` | `INSERT INTO "Product" … ON CONFLICT` (owner: catalog) | **R1** `ProductImportService.upsertFromExternal` (S05); no product SQL remains |
| SQL | `application/catalog-import.service.ts:217` | `INSERT INTO "Outbox"` raw (infrastructure table) | IX.6 `outbox.append(event)` for this domain's own `catalog_sync.import_finished`; product events come from the catalog |
| SQL | `catalog-import.e2e-spec.ts:79,96` | `SELECT … FROM "Product"` in the spec | Read products through `@app/domains/catalog` (`ProductQueryService.getProductsByIds`) (test code may use seed helpers for writes only) |
| MODEL | `catalog-import.e2e-spec.ts:13,41,56` | `ShopModel` injected via `SequelizeModule.forFeature([Shop])` | Fixture helper / tenancy's exported provisioning service (**R1**), no model |
| FK | `migrations/20261002100000-catalog-import.js:16-17` | `"shopId" REFERENCES "Shop"`, `"createdBy" REFERENCES "User"` | Drop the constraints (expand/contract migration, `lock_timeout`); plain ID columns (IX.4) |
| IMPORT | `api/catalog-import.controller.ts:5-8`, `catalog-import.module.ts:2,8` | tenancy (`ShopScoped`), identity (`User`, `AuthModule`), orders (`OrderExportService`) | tenancy and identity entry points are allowed (guards/decorators, **R1**); the orders import is removed (D-10 → S12) |
| RAW CONN | `application/catalog-import.service.ts:36,55-67,98,247`; `api/realtime-topics.ts:11-27` | `@InjectConnection()` raw `Sequelize` against `ImportJob` (own table, allowed) | Replace with the domain's own repository in `infra/` (I.2); the topic policy's table access moves behind the repository and its membership read becomes **R1** `assertMember` |
| SQL (S08/S09, not S07) | `application/integration-sync.service.ts:126,131,154,186`; `application/sync.service.ts:84,101`; `sync.e2e-spec.ts:8-9` | raw `Product` writes/joins, `ProductModel`, `ShopModel` | **R1** `upsertFromExternal` / `applyStockDelta` (S08, S09 specs) |

## D. Work list (suggested order)

1. **Contracts first.** Add the import schemas to `packages/contracts` (A32): start, upload state, job, page, error report, progress event, finished event. Problem codes from the spec's Provides list.
2. **Migration (expand/contract, `lock_timeout`).** Add columns (`nextByteOffset`, `lastRow`, counters, `format`, `headerColumns`, `ignoredColumns`, `scan`, `scannedAt`, `failureCode`, `failureDetail`, `errorReportRows`, `leaseHolder`, `leaseExpiresAt`, `startedAt`, `finishedAt`), widen the `status` check, add `ImportJobHistory` and a handled-event table (registry entries for both, `domain:catalog-sync`), add a partial unique/exclusion mechanism for the active-import cap (III.6), drop the foreign keys to `Shop` and `User`. Remove `ExportJob` creation from this file's ownership once S12 lands (A25, A27).
3. **Domain layer.** Pure modules: row coercion and field mapping, sniffing, batching (flush before a repeated SKU), status machine with `assertNever`, report line writing with the formula guard, file-name sanitiser, message table (A4–A6, A15, AS-15, AS-19, AS-26, AS-30, AS-31, AS-48, AS-58). Ports for repository, storage, scanner, queue, clock.
4. **Upload API.** Controller (one call each, II.1), `start` in one transaction with the cap and rate limit and the idempotency interceptor; `upload`, `complete` (validate parts and size, conditional transition, enqueue after commit; recovery covers a crash in between), `cancel`, `status`, `list`, `error-report` (A9–A13, A31).
5. **Storage port additions** (ranged read, list parts, user-content presign) and the user-content origin configuration; scanner adapter fixes (deadlines, socket cleanup, fail-closed) and production config validation (A7, A8, A31).
6. **Processing worker.** Lease claim and renewal with fencing; scan step; sniff and header check; one cancellable `pipeline` (source → parser → batcher → writer) with `AbortSignal`, per-batch commit of counters and checkpoint, batch-keyed error parts; call `upsertFromExternal` with 500-item batches; terminal transition plus outbox in one transaction; failure codes and the 3-delivery budget; shop status handling; busy-shop hand-back with jitter (A1–A3, A14–A22).
7. **Scheduled jobs** (recovery, expiry, purge) registered with S49, and the two shop-event consumers in a projector module with handled-event dedupe (A21, A26).
8. **Realtime topic** `import:{importId}` with the R1 membership policy; replayable terminal events (A23, A24).
9. **Observability**: structured fields and the metrics list of AS-68 (A28).
10. **Remove** the raw product and outbox SQL, the export controller methods, `OrderExportService` imports, the `kind` message field, models from `index.ts` (A1, A2, A27, A30); update `apps/sse-gateway` registration if the module name changes.
11. **Tests.** Replace `catalog-import.e2e-spec.ts` with the files in `test-plan.md`, add the fake scanner server, the gated storage stream and the recording storage wrapper, and the benchmark script (A29). Record the green run (VII.9).
12. **Re-run** `pnpm --dir packages/backend check:table-ownership --strict` and `pnpm check:boundaries`; the import files must report zero findings (AS-69). Update the debt register rows D-10, D-6, D-7, D-8, D-12 for this domain.

## E. Plan update (2026-10-16): what changed since this list was written

Read from the tree at `3adf8ca4`; details in [research.md](research.md#state-of-the-tree-what-changed-since-gapsmd-was-written-on-2026-10-05).

- A27 is mostly done by S12 (controller/module no longer carry export code); open: `{kind:'import', jobId}` message shape, `imports.concurrent` policy, old e2e.
- A31 shrinks to **one** missing storage capability (ranged `getStream`); list-parts, exact-length part signing, streamed `put` with abort/stall, user-content presign already exist.
- A7: the scanner is the shared `MalwareScanner`; open: inactivity deadline and `mode` on the port, adapter path coverage.
- A24: prefix is already `import`; policy still creator-only.
- C: S08/S09 raw-SQL rows are gone. `.ownership.baseline` is 1 (one finding exists in the domain before this work); the real `check:table-ownership` run is the first implementation task.
- Follow-up from S54 (`400` for DTO failures, `422` only for semantic violations) and the idempotency interceptor's 8-character key minimum change two spec texts (below).

## Resolution (T068, 2026-10-16)

Every item of A (A1–A32) is closed by the new code and proven by the e2e files named in `quickstart.md` "Execution record": A1–A3 `import-processing`/`import-boundary` (writes only through `ProductImportService.upsertFromExternal`, 500-row batches, no product events); A4–A6, A19, A28 `import-processing`/`import-security` and the domain specs; A7–A8 `import-security` (shared scanner, fail-closed, source deleted); A9–A13 `import-upload`/`import-status`; A14–A17, A20–A22 `import-resilience`; A15, A23 `import-report`/`import-lifecycle`; A18 `import-resilience`; A24 `import-status`; A25 the expand/data/indexes migrations plus `migrations/contract/20261016000830-catalog-import-v2-contract.js` (see Spec changes); A26 `import-lifecycle`; A27 `import-lifecycle` AS-70; A29–A30 `import-boundary` and the deleted old files; A31 storage/antivirus specs; A32 the contracts spec.
B: D-10 resolved (already, S12); D-6, D-7, D-8, D-12 are paid for the import files and annotated in `docs/work/architecture/debt-register.md` (the rows stay open for other capabilities).
C: `check:table-ownership --strict` shows no finding for the import files (the old allow-list entry for `catalog-import.service.ts` in `scripts/technical-table-scan.ts` is removed). D: done, in the order of `tasks.md`.
Open: the runtime proofs (T072) and the unrun ops artifacts (SC-001, SC-002, SC-003, SC-006, SC-008, AS-29 edge, FR-044).

## Spec changes

The human-signed `spec.md` is not edited. The living-spec page (`docs/spec/capabilities/S07-bulk-import.md`) states the behavior below, and the tests assert it:

- **AS-02 / AS-54 (status code)**: DTO, query and cursor failures answer `400 validation_failed` (S54 toolkit, house `ZodPipe`), not `422 validation_failed`. `422` stays for `invalid_parts`, `size_mismatch`, `idempotency_key_required|invalid|reuse`.
- **AS-03 / AS-04 / AS-05 (key shape)**: the examples use key `k1`; the toolkit requires 8–128 characters of `[A-Za-z0-9_-]`, so a shorter key is `422 idempotency_key_invalid`. Tests use keys of at least 8 characters.
- **AS-70 wording**: "404 (served by S12)" is read as "no longer served by catalog-sync" (S12 follow-up).
- **AS-25 (adapter spec location)**: the scanner protocol cases are proven in `libs/infrastructure/antivirus/clamd-scanner.spec.ts` (extended) instead of `infra/clamav.spec.ts`, because the adapter moved to the shared library (S29 follow-up); `questions.md` LOCAL line "scanner stays inside catalog-sync" is superseded by the same follow-up.
- **AS-64 / FR-041 (event name)**: the event is registered as `catalogsync.import_finished` on topic `catalogsync.events`, not `catalog_sync.import_finished` on `catalog-sync.events`: the platform's patterns allow no `_` in the first segment of a type nor `-` in an aggregate type (same rule S08 met). Payload and version are as specified; `importEventSchemas` in `@contracts` carries the registered key.
- **AS-63 / FR-040 (read routes)**: the three read routes require `shop.read` instead of `products.read`; every role holds both, and only `shop.read` passes the S03 status gate of a `SUSPENDED` or `DELETING` shop, which AS-63 needs ("reads still answer 200").
- **T024 (contract migration)**: `migrations/contract/20261016000830-catalog-import-v2-contract.js` follows the S15/S16 precedent: it ships for a later release, is run by hand, and refuses while any legacy value is not yet copied. It was not run against the shared stack.
- **FR-009 / AS-24 (deadlines)**: unchanged in behavior; implemented as `inactivityMs` + `timeoutMs` options of the shared port.

## Sibling-spec follow-ups

- **S05**: publish a closed list of rejection `code`s per `ExternalProductInput` field in its contracts package (S07's message table is pinned by a unit test that fails when a code has no message); keep `field` values equal to the `ExternalProductInput` property names (`externalSku`, `title`, `description`, `brand`, `category`, `priceMinor`, `quantity`, `tags`).
- **S29**: `MalwareScanner.scan` gains `{ inactivityMs? }` and the port gains `mode: 'active' | 'disabled'` (additive; the media caller is unaffected); `clamd-scanner.spec.ts` gains the quiet-socket, size-limit and half-reply cases; `infra/clamav.ts` in catalog-sync is deleted by S07.
- **S12**: `ObjectStorage.getStream(key, { start })` is added by S07 (additive); S12's reads are unaffected. The old `catalog-imports` assertions in `order-export*.e2e-spec.ts` remain valid.
- **S51**: `import:{importId}` terminal events are published with `replay: true`, progress with `replay: false`; the policy is asynchronous and calls S03's `assertMember` (the registry already accepts an async policy).
- **S53**: `catalogsync.import_finished` v1 joins topic `catalogsync.events` (shared with S08); consumers filter on `type`.
- **S08**: `integration-boundary.e2e-spec.ts` AS-80 ("the barrel exports exactly …") lists the barrel's exports without `CatalogImportProjectorModule`; this capability must export it (the projector app registers the two shop-event consumers through it), so add it to that list. Until then that one test fails. The S08 scan of "integration files" skipped only `test/`; S07's kit now lives in `testing/import-kit.ts` (the dependency rule `x6` only allows `libs/**/testing/` to import the e2e harness), so the scan's filter gained `testing/` (see Gate repairs).
- **S54**: nothing to change; S07 relies on the idempotency interceptor, `ZodPipe` and the config-validation hook as they are.
- **W04**: subscribe to `import:<importId>` (not `job:<id>`); read `importId`, `parts[].url`, `partSize`, `partCount` from the start response (no `jobId`, `partUrls`, `uploadId`, `key`); call `GET …/upload` to resume, `POST …/cancel`, `GET …/error-report` for the download link (the status route no longer carries `errorReportUrl`); generate an `Idempotency-Key` of 8+ characters per start attempt and reuse it on retry.
- **J04**: treat `DONE` or `catalogsync.import_finished` as the trigger, then wait for S32's projection (S05's `catalog.product_*` events).
- **S03**: nothing required; S07 adds consumers `catalog-sync-import-offboarding` and `catalog-sync-import-shop-deleted` and reads membership with `assertMember`; import history is not part of the shop export (documented in `questions.md`).
- **S08 / S09**: nothing required; `catalog-sync.events` and the `catalog-sync.` job-name prefix are shared by name only.

## F. Plan coverage of follow-ups

Each follow-up from built specs (S01, S05, S08, S12, S29, S49, S50, S51, S53, S54) is a row of the table in [plan.md](plan.md#follow-ups-left-by-built-specs-each-is-a-requirement) with its home in the design.

## Gate repairs

- `catalog-sync/catalog-import.e2e-spec.ts` had been deleted. It carried no scenario id and its subject name did not match a deleted file, so the integrity gate found nothing that replaced it. It is back at the same path as a spec on the new import kit with its four original cases: 10k rows with 3 bad ones plus a re-import, resume from the checkpoint, binary file named .csv refused, and no export served. The error report is now one line per field problem, so the 3 bad rows give 9 lines plus the header. The spec and `tsc --noEmit` pass, and `check-tests.py integrity` exits 0.
- Gate step `depcruise` failed with four `x6-production-never-imports-test` errors: `catalog-sync/test/import-kit.ts` imports the harness in `test/utils/`, and only `libs/**/testing/` may. The kit moved to `catalog-sync/testing/import-kit.ts` (its fakes stay in `test/fakes/`) and the ten import specs import it from there. `integration-boundary.e2e-spec.ts` (S08 AS-80) scans domain sources and flagged the moved kit, so its scan filter now skips `testing/` as it already skips `test/`; the forbidden patterns are unchanged. `depcruise`, `tsc --noEmit` and `import-boundary.e2e-spec.ts` pass; the only remaining failure in the S08 boundary spec is the barrel-list case already recorded above.
- `libs/infrastructure/outbox/outbox-isolation.spec.ts` (S53 AS-09) still expected `catalog-sync/application/catalog-import.service.ts` in the hand-over list. S07 deleted that service and `HANDED_OVER` in `scripts/technical-table-scan.ts` is now empty, so two cases failed. The list case now expects an empty list; the "scan sees the outbox table" case now scans a temporary directory holding a file with `INSERT INTO "Outbox"` and expects one `Outbox` hit, so it still fails if the scan stops detecting. No scenario was dropped; the spec and `tsc --noEmit` pass.

### Gate repair (catalog-sync suite, 2 failures in S08 tests)

- **S08 AS-78 (log shape)**: nine S07 log calls (`import-lifecycle.service.ts`, `import-runner.service.ts` x2, `import-start.service.ts` x4, `import-live.adapter.ts`) logged a formatted string. They now log `{ action: 'import.<event>', importId, error }`. This was a code defect, not a test fault.
- **S08 AS-80 (barrel)**: the barrel exports `CatalogImportProjectorModule`, which the projector app imports. The test's exact export list lacked it, so the name was added; the list is still compared exactly.
- Re-run: `libs/domains/catalog-sync` 32 suites / 467 tests pass, and `tsc --noEmit` is clean.
