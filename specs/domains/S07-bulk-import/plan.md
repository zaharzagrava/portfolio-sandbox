# Implementation Plan: S07 — Bulk Catalog Import (domain `catalog-sync`)

**Branch**: `S07-bulk-import` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written; no line was edited by a human), `.specify/memory/constitution.md` v3.1.0.

## Summary

Replace the 384-line `CatalogImportService` (raw `Product`/`Outbox` SQL, `@InjectConnection`, one flat scan timeout, row-number-only checkpoint, no lease, no history, 6 states) with the design of the spec: a closed 8-state job machine with history; an upload handshake (`start` under `Idempotency-Key`, `upload` resume, `complete` 202, `cancel`, `status`, `list`, `error-report`); a mandatory fail-closed malware scan through the shared `MalwareScanner` port; magic-number sniffing; one cancellable `pipeline` (source → parser → batcher → writer) read from a byte offset; 500-item batches written only through S05 `ProductImportService.upsertFromExternal`; per-batch commit of counters + checkpoint under a fenced lease; batch-keyed error-report parts; recovery / expiry / purge jobs (S49); shop-lifecycle consumers; `catalog_sync.import_finished` on `catalog-sync.events`; topic `import:{importId}` with an R1 membership policy.

Approach (same shape as S08, which shares the domain): contracts first → pure `domain/` core (row coercion, sniffing, batcher, status machine, report writer, file-name sanitiser, message table, parse pipeline) → ports in `domain/ports/` → `infra/` adapters (Sequelize repository on the two own tables, storage, scanner, queue, clock) → thin `application/` services → `api/` controller → worker, jobs, projector consumers, topics → remove the old code. Every `gaps.md` item (A1–A32, B: D-6/D-7/D-8/D-10/D-12, C ownership lines, D work list) and every follow-up below is mapped in [research.md](research.md#gap-coverage).

### Follow-ups left by built specs (each is a requirement)

| From | Follow-up | Where handled |
|---|---|---|
| S01 | `Firewall` takes no `throttle`/`skipThrottle`; sensitive routes use `Firewall({ sensitive: true })`, not `SessionNotRevokedGuard` | Import routes use `ShopScoped(...)` only (no `@RateLimit`, no `SessionNotRevokedGuard` today); the start route is not "sensitive" (not credential-changing), documented in research D-14. Boundary e2e greps for `throttle`/`skipThrottle`/`SessionNotRevokedGuard` in the import files |
| S05 | write only through `upsertFromExternal`; no `catalog.product_changed`, no `INSERT/UPDATE "Product"`; `price`→`priceMinor`; `quantity` ≥ 0 | `ImportCatalogGateway` port (R1 adapter) sends `{externalSku, title, description, brand, category, priceMinor, quantity?, tags?}`; AS-69 static check; raw SQL and `ProductChanged` import deleted |
| S08 | topic `catalog-sync.events` is shared (consumers filter on `type`); renamed jobs `catalog-sync.sync-all` / `.reconcile-all` | S07 adds only `catalog_sync.import_finished` to the same topic (registered once in `CATALOG_SYNC_AGGREGATE` style, no second topic definition); its jobs use the `catalog-sync.` prefix already |
| S12 | export routes, `OrderExportService`, `kind` field and `kind:'export'` branch, e2e export case are gone and must not return | **Already removed** from `catalog-import.controller.ts`/module (verified 2026-10-16); remaining work: the worker's `{kind:'import', jobId}` message becomes `{importId}` (AS-70); `imports.concurrent` policy deleted; boundary e2e asserts no `orders` import and no `kind` |
| S12 | Storage port: `put` gains `{signal, inactivityTimeoutMs}`; `presignGet` gains `contentType`, `userContent`, RFC 6266 name | Adopted, not forked: the report is written with `put(..., {signal, inactivityTimeoutMs})`, delivered with `presignGet(key, {expiresInSec: 600, downloadName, contentType: 'text/csv; charset=utf-8', userContent: true})` |
| S29 | `infra/clamav.ts` shim → `@app/infrastructure/antivirus`; delete shim | Scanner adapter replaced by the `MalwareScanner` port (`AntivirusModule`); `infra/clamav.ts`, `infra/clamav.spec.ts` and the `clamav` import deleted; the protocol-level scenarios (AS-25) are proven by the library's `clamd-scanner.spec.ts` + the fake-clamd e2e (see research D-05 for the deadline gap) |
| S49 | `declareJobType` with payload contract next to `JobPayloads`; `JobsService.cancel` discriminated; catch `InvalidScheduleError` | Three jobs declared in `infra/import.jobs.ts` (pattern of `offline-sync.jobs.ts`); `cancel` not called |
| S50 | drop `imports.concurrent` and its `acquire` call; `@RateLimit` is metadata only; enforcement is the global interceptor of `RateLimitModule.forRoot()` | Concurrency = lease. The start limit is a **code-called** `limiter.check('catalog-sync.import-start.shop', shopId)` before the create (not decorator metadata), so it holds in any app. Domain `catalogSyncRatePolicies` gains `catalog-sync.import-start.shop`, loses `imports.concurrent`. `RateLimitModule.forRoot()` stays in the HTTP apps; no new HTTP app |
| S51 | prefix `import`, no `job:`; `import:<jobId>` topic; W04 must subscribe to `import:<id>` | Registration already `import`; policy rewritten (R1 `assertMember`), terminal events `replay: true`. Sibling follow-up recorded for W04 |
| S53 | register aggregate types with `TopicRegistry`/outbox topic groups; replace raw `INSERT INTO "Outbox"` (G-52) and `notify` callers with `append` | Raw outbox insert disappears with the product write; the finished event uses `outbox.append` in the transition transaction; `notify` callers in `sync.service.ts` / `integration-sync.service.ts` are S08/S09's (already migrated: verified by grep in research §Gap coverage C) |
| S54 | `422` only for semantic rule violations; idempotency uses `422 idempotency_key_required/_invalid/_reuse`; DTO failures `400 validation_failed` | **Conflict with spec text** (spec says `422 validation_failed` for start/list DTO failures, AS-02, AS-54). Follow-up wins: DTO and query failures are `400 validation_failed`; `422 invalid_parts` / `size_mismatch` / `idempotency_*` stay `422`. Recorded under "Spec changes" in `gaps.md` and in the living-spec page; tests assert `400` for AS-02/AS-54 shapes (not `422`) |

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 22, NestJS 11 monorepo (`packages/backend`, `packages/contracts`; `packages/web` only for the W04 journey).

**Primary Dependencies**: NestJS, Sequelize (raw parameterised SQL against the two own tables, only inside `infra/` repositories), `zod`, `fast-check`, `csv-parse` (already used; kept, wrapped in the pipeline stage), existing infra: `TransactionRunner`/`@Transactional`, `OutboxService.append`, `TaskQueue` (`enqueue` with `delaySeconds`, `consume` with heartbeat and delivery count), `Idempotent()` + `IdempotencyModule`, `RateLimiterService`, `JobsService`/`declareJobType`/`@JobHandler`, `TopicRegistry`/`RealtimePublisher`, `MalwareScanner`/`AntivirusModule`, `ObjectStorage`, `Clock` (`CLOCK`), metrics registry, S03 `ShopScoped`/`ShopAccessService.assertMember`, S05 `ProductImportService`.

**Storage**: PostgreSQL (own tables `ImportJob` and new `ImportJobHistory` (shop-event idempotency uses the shared inbox); FKs to `Shop`/`User` dropped); object storage (`imports/<shopId>/<importId>/source`, `…/report/<batch>.csv`); Kafka topic `catalog-sync.events` (out), `tenancy.events` (in); SQS `catalog-imports` + DLQ (already in `elasticmq.conf` and terraform: verified, L-002/L-020), Redis only through S50 and S51.

**Testing**: Jest e2e via `scripts/sdd/test-spec.sh` (real Postgres, Redis, MinIO, queue stand-in), unit `it.each` + `fast-check` for pure logic, `fake-clamd` TCP server, gated storage stream, recording storage wrapper, frozen clock; Playwright happy path owned by W04. Layout and scenario mapping: [test-plan.md](test-plan.md) (71 scenarios, 9 e2e files).

**Target Platform**: Linux containers: `apps/core` (HTTP, `CatalogImportModule`), `apps/worker` (`CatalogImportWorkerModule`: consumer + 3 jobs), `apps/projector` (`CatalogImportProjectorModule`: 2 shop-event consumers), `apps/sse-gateway` (`ImportJobTopicsModule`), `apps/local-monolith` hosts all.

**Project Type**: backend domain module (web-service + workers). No new deployable app (I.6): all four modules plug into existing apps.

**Performance Goals**: SC-001 (1M rows / 5 GiB < 15 min, < 200 MB RSS), SC-002 (20 shops in parallel), SC-006 (progress ≥ 1/s at 20k rows/s). Budget per batch: parse 500 rows + one S05 call + one transaction (counters, checkpoint, history-free) + one progress publish.

**Constraints**: no network I/O inside a DB transaction (III.3): the S05 call, storage calls, scanner, queue enqueue and realtime publish all happen outside; the batch commit is one short transaction; each outbound call has a timeout (IV.6); one retry layer (queue redelivery, ≤ 3).

**Connection arithmetic (III.12)**: a worker holds ≤ 1 DB transaction per running import; worker concurrency 4 (as today) ⇒ ≤ 4 import connections + S05's own per-call transaction (also ≤ 4 at a time) per worker instance; with the pool and instance counts used in `apps/worker` (unchanged) this stays far below the DB limit. The heartbeat and lease renewal use short single statements, no held connection.

**Scale/Scope**: 5 GiB / ~1M rows per file, 3 active imports per shop, 71 acceptance scenarios, 46 FRs, 9 SCs.

No `NEEDS CLARIFICATION` remain; unknowns resolved in [research.md](research.md).

## Constitution Check

*GATE: passes before Phase 0 and after Phase 1 design.* Every PR gate, with result.

| # | Gate | Status | How |
|---|---|---|---|
| 1 | Boundaries (I, Matrix) | PASS | New code in `domain/` (pure + `ports/`), `infra/` (adapters), `application/`, `api/`; `application/` imports no `infra/` (the old `../infra/clamav` import dies, D-6); no `forwardRef`, no `Scope.REQUEST`; cross-domain imports only the entry points of `tenancy`, `identity`, `catalog`; `index.ts` exports modules only |
| 2 | Controllers (II.1) | PASS | One call each; `Idempotent()` interceptor, `ShopScoped`, `ParseUUIDPipe`, zod pipe (existing `api/zod.pipe.ts`); the 202/Location/200-replay decision is made by the service returning `{job, created}` and a response-mapping interceptor/`@Res({passthrough})` header set from the result — no branching on domain state in the controller beyond reading that flag (research D-12) |
| 3 | Data access (III) | PASS | Principal in every predicate (`WHERE id AND "shopId"`, III.4); state change = conditional `UPDATE … WHERE status = :from` + history row in one transaction (III.7, `assertNever`); active cap and one-winner rules by the store (partial unique index + advisory-free `INSERT … WHERE (SELECT count(*) …)` guarded by a per-shop row lock — research D-08, III.6); keyset list with `(createdAt DESC, id DESC)` and opaque cursor (III.10); no I/O inside transactions (III.3) |
| 4 | Migrations (III.11) | PASS | Expand migration `…-catalog-import-v2-expand.js` (columns, history, handled-event, indexes; `lock_timeout`), data step (map legacy `error`, `checkpointRow`, `objectKey`), contract migration (drop FKs, drop `objectKey` pending default, drop legacy columns after code stops reading them). Never at app start |
| 5 | Messaging (IV.4–IV.6) | PASS | Finished event via `outbox.append` in the transition transaction; the two shop-event consumers are zod-validated `Projector`s with documented idempotency (`inbox` for offboarding, `natural` for deletion); poison → `PermanentError` → DLQ; import message zod-validated, malformed → reject; timeouts on storage (`timeoutMs`), scanner (60 s inactivity, 30 min total), S05 call (batch deadline), queue |
| 6 | Contracts (V) | PASS | zod schemas in `packages/contracts/src/catalog-sync/imports.ts` (+ `index.ts` export) first; response DTOs only (no storage key, handle, lease, signature name); problem+json codes; `Idempotency-Key` on the start POST (V.6) |
| 7 | Web (VI) | N/A | W04 owns screens; only the journey test, blocked until the page exists (→ UNVERIFIED if still absent) |
| 8 | Tests (VII) | PASS | VII.2/VII.3 per route (matrix in test-plan), VII.4 consumers (queue message, two shop events), 9 e2e files + unit specs for pure logic only; Gate 9 faults forced (AS-23, AS-24, AS-44, AS-62); green run recorded in `quickstart.md` Execution record |
| 9 | Operational (VIII) | PASS | Structured logs with `importId`/`shopId`/`requestId`, no row data/URLs (AS-68); config validated at startup (scanner mandatory in production — **config rule already exists for `clamav_host` in production for S29**, extended to cover import; research D-05); jobs single-run (`concurrency:1, fleetConcurrency:1`) and idempotent; graceful shutdown aborts at a batch boundary and releases the lease |
| 10 | DB isolation (IX) | PASS | `ImportJob` (owned) and new `ImportJobHistory` registered `domain:catalog-sync` in `db/ownership.ts` (handled events use the shared inbox); no query touches `Product`, `Outbox`, `Shop`, `User`; FKs dropped; membership via R1 `assertMember`; product reads in tests via `ProductQueryService.getProductsByIds`; `check:table-ownership --strict` zero for the import files (AS-69) |
| 11 | Monorepo (X) | PASS | Barrel exports `CatalogImportModule`, `CatalogImportWorkerModule`, `CatalogImportProjectorModule`, `ImportJobTopicsModule` (+ existing S08/S09 modules and `catalogSyncRatePolicies`); no model exported; `apps/projector` imports the new projector module |

**Transactions (cross-spec rule 4)**: baseline direct `sequelize.transaction` count for the domain is `0` (`.tx.baseline`); no `// S54 T037 audit` marker exists in the import files (only the boundary spec's regex mentions it). All new transactions use `TransactionRunner.run`; the count must stay 0.

**Debt register**: D-6, D-7, D-8, D-12 closed for the import files; D-10 already closed on S12's side, S07 finishes it (message shape, policy removal, assertions). **Complexity Tracking**: no unjustified violation.

**Known failure classes (checked before design)**

| Class | Plan response |
|---|---|
| L-018 / L-015 / L-004 (boot) | Final-checkpoint tasks boot `core`, `worker`, `projector`, `sse-gateway` **standalone** and `local-monolith` with the real wiring (not only jest); `CatalogImportWorkerModule` imports every module its providers need itself (`TenancyModule`, `ProductModule`, `AntivirusModule`, `IdempotencyModule` where used, `ClockModule`, `EventsModule`/`OutboxModule`, `JobsModule`) |
| L-010 | `start` is idempotent through the key (replay stored body; in-flight 409); `complete` and `cancel` are idempotent by conditional transition (200 replay) |
| L-001 | Queue options validated where the message is created: `ImportQueue.enqueue` accepts `delaySeconds` only, never `groupId` (`catalog-imports` is a standard queue); a unit test on the port wrapper |
| L-002 / L-020 | `catalog-imports` and its DLQ exist in `elasticmq.conf` and `main.tf` (verified); no new queue is added, so no reload needed; the checklist task re-compares anyway |
| L-011 | New tables in the migration and in `ownership.ts`; the object-storage prefixes need no new bucket; user-content origin setting documented in quickstart |
| L-003 | No "A or B" assertions; environment limits (e.g. MinIO lacks a feature) reported as blocked, never as pass |
| L-005 / L-006 | Every e2e creates its own shop, user, file and job; no reliance on seeded stock; browser suite run once on an empty stack by the final checkpoint |
| L-007 | Runner timeouts; the frozen clock drives lease/expiry/stall; no wall-clock waits |
| L-008 | e2e run per file (9 files), each a fresh process; a batch without a summary line is a crash |
| L-013 | Fault triggers (Postgres trigger on outbox/job table, scanner stall, TCP proxy) dropped in `afterEach`; queue and bucket prefixes reset in `beforeEach` |
| L-016 | The repair path (purge, abort upload, delete object) tolerates "already gone" (missing object / unknown upload = success) |
| L-017 | Old `catalog-import.e2e-spec.ts` scenarios are carried by name: 10k-rows-3-bad → AS-47, resume at checkpoint → AS-34, binary refused → AS-26, progress events → AS-47 (20 events); test-plan row updated if a file is renamed |
| L-019 | Runtime proofs (standalone boots, empty-stack run, benchmark script) are scripted tasks of the final checkpoint, not left to a converge pass |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S07-bulk-import/
├── plan.md              # this file
├── research.md          # decisions, gap coverage, risks
├── data-model.md        # tables, state machine, migrations, storage layout
├── quickstart.md        # validation scenarios + Ops artifacts
├── contracts/
│   ├── http-api.md      # routes, schemas, problem codes, headers
│   ├── events-and-messages.md  # queue message, outbox event, consumed events, live events, jobs, policy, config
│   └── ports.md         # domain ports, R1 calls, infrastructure additions
└── tasks.md             # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
docs/spec/capabilities/S07-bulk-import.md        # living-spec page: written FIRST (rule 0); no page exists yet; no .reviewed.json touched

packages/contracts/src/catalog-sync/imports.ts   # zod: start/upload/complete/job/page/error-report/progress/event schemas, problem + failure codes
packages/contracts/src/catalog-sync/index.ts     # + export
packages/backend/migrations/2026101x-catalog-import-v2-{expand,data,contract}.js
packages/backend/db/ownership.ts                 # + ImportJobHistory (domain:catalog-sync)
packages/backend/libs/infrastructure/storage/    # + getStream(key,{start}) ranged read (in-memory + S3 adapters); presign/put already adopted
packages/backend/libs/infrastructure/antivirus/  # + inactivity/total deadline options if the library lacks them (research D-05)
packages/backend/libs/domains/catalog-sync/
├── domain/
│   ├── import-status.ts        # 8 states, 13 transitions, assertNever, reasons
│   ├── import-row.ts           # exact decimal price, stock, tags, field mapping (replaces rows.ts)
│   ├── import-sniff.ts         # magic numbers, BOMs, NUL, UTF-8 check
│   ├── import-batcher.ts       # 500-batch, flush-before-repeated-SKU
│   ├── import-pipeline.ts      # pure stream stages (object-mode), abort-aware (infra/import-pipeline.ts if Node streams are judged infra; see research D-06)
│   ├── error-report.ts         # line writer, formula guard, message table, field mapping
│   ├── file-name.ts            # display/download name sanitiser
│   ├── import-limits.ts        # defaults + validated config shape
│   └── ports/                  # import.repository, import-storage, import-catalog.gateway, import-queue, import-shop-status, (clock = existing CLOCK)
├── application/
│   ├── import-start.service.ts     # start, upload state, complete, cancel (transitions + cap + enqueue-after-commit)
│   ├── import-query.service.ts     # status, list, error-report
│   ├── import-runner.service.ts    # claim lease, scan, sniff, header, pipeline, per-batch commit, failures
│   ├── import-lifecycle.service.ts # recovery, expiry, purge, offboarding, shop deletion
│   ├── import-events.ts            # catalog_sync.import_finished definition + realtime publishing helpers
│   └── import-metrics.ts
├── infra/
│   ├── repositories/sequelize-import.repository.ts
│   ├── import-storage.adapter.ts   # keys, report parts, ranged read, list parts, presign on user-content origin
│   ├── import-catalog.adapter.ts   # R1 ProductImportService
│   ├── import.consumer.ts          # queue consumer (zod message, delivery count, hand-back with jitter)
│   ├── import.jobs.ts              # recover-stalled-imports, expire-pending-imports, purge-imports
│   ├── import-lifecycle.consumers.ts  # tenancy.shop_offboarding_started / shop_deleted
│   └── import-parse-stage.ts       # csv/jsonl → record stream with offsets
├── api/
│   ├── catalog-import.controller.ts   # rewritten; DTOs from contracts via zod pipe
│   └── realtime-topics.ts             # R1 assertMember policy
├── catalog-import.module.ts           # CatalogImportModule / CatalogImportWorkerModule / CatalogImportProjectorModule
├── realtime-topics.module.ts          # ImportJobTopicsModule (+ TenancyModule)
├── rate-limit-policies.ts             # + catalog-sync.import-start.shop, − imports.concurrent
├── index.ts                           # barrel: four import modules, no model
├── test/fakes/fake-clamd.ts, gated-storage.ts, recording-storage.ts
└── import-{upload,processing,security,resilience,report,status,fairness,lifecycle,boundary}.e2e-spec.ts
packages/backend/apps/{core,worker,projector,sse-gateway}/…   # wire the modules; projector imports CatalogImportProjectorModule
packages/backend/scripts/bench/catalog-import-bench.ts       # SC-001/SC-002 artifact
packages/web/tests/seller-import.spec.ts                      # W04 happy path (blocked → UNVERIFIED if W04 page absent)
```

Deleted: `application/catalog-import.service.ts`, `domain/rows.ts` (+ spec, replaced), `infra/catalog-import.worker.ts`, `infra/clamav.ts`, `infra/clamav.spec.ts`, `catalog-import.e2e-spec.ts`, policy `imports.concurrent`.

**Structure Decision**: one backend domain, hexagonal layers inside `libs/domains/catalog-sync`, shared contracts package, two small additive infrastructure changes (ranged read; scanner deadlines if missing). No new app.

## Phases and ordering (input to `/speckit-tasks`)

0. **Living-spec page first** (`docs/spec/capabilities/S07-bulk-import.md`, rules + behaviors, `[proof:]`/`[code:]` true, `python3 scripts/livespec/check.py`), then contracts.
1. **Contracts** (`imports.ts`) and problem/failure codes; contract spec for each schema.
2. **Pure domain** with unit specs: status machine, row coercion, sniffing, batcher, file name, error report, pipeline backpressure.
3. **Migrations** (expand → data → contract) + `ownership.ts`; repository (conditional transitions, cap, lease claim/renew/fence, checkpoint commit, keyset list) with repository e2e.
4. **Infrastructure additions**: ranged `getStream`, scanner deadlines; storage adapter (report parts, user-content presign).
5. **Upload API** (`start`/`upload`/`complete`/`cancel`/`status`/`list`/`error-report`) with idempotency, rate limit, shop-status gate → `import-upload` and `import-status` e2e.
6. **Runner + consumer** (lease, scan, sniff, header, pipeline, batch commit, failure mapping, cancel at boundary, shutdown) → `import-processing`, `import-security`, `import-resilience`, `import-report` e2e.
7. **Jobs + projector consumers + topic policy + metrics** → `import-fairness`, `import-lifecycle`, remaining `import-status` cases.
8. **Removal and wiring**: delete old service/worker/clamav shim/old e2e, drop `imports.concurrent`, update modules, `index.ts`, apps; `import-boundary` e2e; `check:table-ownership --strict`, `check:boundaries`.
9. **Final checkpoint (scripted, L-019)**: standalone boots of `core`, `worker`, `projector`, `sse-gateway` and the monolith; whole capability suite once; empty-stack run; benchmark script written (run = Ops artifact); update `gaps.md`/debt register/UNVERIFIED.

## Complexity Tracking

No violations. Two items worth a reader's attention, neither an exception:

| Item | Why | Not a violation because |
|---|---|---|
| Counters/checkpoint and the catalog write are separate stores (IX.4) | A transaction cannot span S05 and this domain | Spec AS-35 bounds the effect to one batch created/updated→unchanged; no cross-domain transaction exists |
| `400` instead of spec's `422` for DTO failures | S54 follow-up | Spec change recorded in `gaps.md` |
