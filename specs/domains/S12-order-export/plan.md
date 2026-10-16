# Implementation Plan: S12 — Order Export (domain `orders`)

**Branch**: `S12-order-export` (working branch `sdd/auto`) | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md` (61 scenarios AS-01–AS-61, FR-001–FR-040, SC-001–SC-009), `test-plan.md`, `gaps.md` (A1–A24, debt B, ownership C, order D), `questions.md` (defaults accepted as written, none edited by a human), constitution `.specify/memory/constitution.md`, and the follow-ups listed in the invocation (S05, S10, S49, S51, S53).

## Summary

Replace the 99-line `OrderExportService` (a cursor held for the whole run, raw SQL, `Product` join, the import queue) with a layered, fenced export in `orders`: an `ExportJob` state machine with history and lease, keyset batches of 1,000 lines driven as an async generator into one `pipeline` (CSV encoder → storage `put`), a per-attempt object promoted only by the fenced completion, retries by queue redelivery only, recovery/expiry/purge jobs on S49, two tenancy event consumers on S53, an `order_export.finished` outbox event, a live topic `order-export:<id>` with a shop-member policy, and the HTTP routes under `/shops/:shopId/order-exports`. The routes, queue, worker branch and `OrderExportService` leave `catalog-sync` and the `orders` barrel (debt D-10, D-8). Phase 0/1 findings below show that most "requires" of the draft gaps are **already in the tree** (S05 `externalSku`, S10 item snapshot, S49 `declareJobType`, S51 prefix `order-export`, S53 projector framework, S54 toolkit), which shrinks the "temporary read" path in gaps.md §D to nothing.

## Technical Context

**Language/Version**: TypeScript (NestJS, Node ≥ 22), Sequelize 6 + raw keyset SQL through the domain's own repository. `packages/contracts` (zod) for schemas.

**Primary Dependencies** (all in-repo, verified present): `ObjectStorage` (`libs/infrastructure/storage`, has `put`, `head`, `getStream`, multipart, `presignGet`), `TaskQueue` (`libs/infrastructure/sqs`: `enqueue` with `delaySeconds`, `consume` with heartbeat, `receiveCount`, `bodySchema` → DLQ, `queueExists`), jobs (`libs/infrastructure/jobs`: `declareJobType`, `JobsService`, cron schedules with leases), outbox (`libs/infrastructure/outbox`), projections consumer framework (`libs/infrastructure/projections`, `Projector` with `idempotency: 'inbox'`), realtime (`RealtimePublisher.publish(topic, type, data, {replay})`, `TopicRegistry.define`), idempotency (`@Idempotent`), rate limit (`@RateLimit`, policy registry), `TransactionRunner` (S54), `Clock`, graceful-shutdown registry, tenancy (`ShopScoped`, `ShopAccessService.assertMember`, events `ShopOffboardingStarted`, `ShopDeleted`), catalog (`ProductQueryService.getProductsByIds`, returns `externalSku`).

**Storage**: PostgreSQL (`ExportJob`, new `ExportJobHistory`; reads `ShopOrder`, `BisOrder`, `BisOrderItem`), object storage (CSV), Redis (realtime, rate limit, idempotency), SQS/ElasticMQ queue `order-exports` (+ `-dlq`), outbox → topic `order-exports.events`.

**Testing**: jest e2e on real routes per `test-plan.md` (5 files in `libs/domains/orders/`), 4 unit specs under `domain/`, benchmark script `scripts/bench/order-export-bench.ts`, Playwright journey owned by W04. Run through `/opt/sdd/repo/scripts/sdd/test-spec.sh`; static: `tsc`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `python3 scripts/livespec/check.py`.

**Target Platform**: `apps/core` (routes), `apps/worker` (consumer, jobs, tenancy consumers), `apps/sse-gateway` (topic policy), `apps/projector` (G-54 only: drop a model registration).

**Project Type**: backend web service, three deployable apps plus a monolith host.

**Performance Goals**: 1 M lines < 5 min, heap < 200 MB flat (SC-001); ≤ 3,000 lines read ahead when storage is stopped (SC-002); progress ≤ 1/s.

**Constraints**: no long transaction or pinned connection between batches (III.3/III.10); one `QUEUED|RUNNING` export per shop enforced by a partial unique index; no cross-domain SQL (IX.4); retries at the queue layer only (IV.6); no new direct `sequelize.transaction` (rule 4).

**Scale/Scope**: up to 20 M lines per export (≈ 2.5 GB); one active export per shop.

No `NEEDS CLARIFICATION` remains; unknowns resolved in [research.md](research.md).

## Constitution Check

*Gate before Phase 0; re-checked after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| I Layered modules / D-6 | `domain/` (pure rules, ports with tokens) ← `application/` ← `api/`; `infra/` implements ports; controller → one service call per method; old service deleted, not refactored | Pass |
| II Pipeline & routing | `ShopScoped('orders.manage')`, `@Idempotent`, `@RateLimit('orders.export-start.shop')`, zod pipes with contracts schemas | Pass |
| III Data & transactions | conditional transitions + history in `TransactionRunner.run`; keyset reads, no cursor; partial unique index; expand/contract migration with `lock_timeout`; no FK; enqueue after commit with recovery for a lost message | Pass |
| IV Communication | queue consumer validates (`bodySchema`), outbox for the finished event keyed by `exportId`, tenancy events through S53 `Projector` with inbox | Pass |
| V Contracts & errors | schemas in `packages/contracts`; problem+json codes of the spec; no storage key or lease in DTOs | Pass |
| VII Testing | e2e files written first and red (VII.9), each degradation path forces its fault; unit specs for pure rules only | Pass |
| VIII Operational | startup config validation, structured logs without row data, metrics, graceful shutdown restores `attempt` | Pass |
| IX Isolation | tables `ExportJob`, `ExportJobHistory` in `db/ownership.ts`; FKs dropped; SKU only via R1; membership only via tenancy R1 | Pass |
| X Boundaries / D-8 | barrel exports only the three modules; `OrderExportService` and `ExportJobTopicsModule` leave the TRANSITIONAL block (`orders-boundary.e2e-spec.ts` allow-list shrinks); `catalog-sync` stops importing `orders` | Pass |

**Gate result**: no violation needing justification (Complexity Tracking empty). Post-design re-check: same, see end of document.

## Findings that change the draft gaps (verified against the tree on 2026-10-16)

| Draft assumption (gaps.md) | Tree today | Consequence |
|---|---|---|
| A24: items carry no title/discount/total | `BisOrderItem` has `title` (nullable until `item-backfill.service.ts` has filled legacy rows), `discountMinor`, `lineTotalMinor` (nullable); `shopId` nullable | Read the snapshot columns. Legacy rows with null `title`/`lineTotalMinor`: the reader falls back per row (title → `getProductsByIds` title in the same SKU batch; total → `quantity*priceAtPurchase-discountMinor`) so AS-03 holds before the backfill is complete. The fallback is a pure function in `domain/` and is removed with a note when the backfill is proven complete (not in this capability). |
| S05 `externalSku` is `[CONTRACT]` | `ProductDto` already has `externalSku: string \| null` (`catalog/domain/product-view.ts`) | Use R1 directly; the "drop the SKU column" fallback is not needed. |
| `realtime-topics.ts` uses `job:` | already `order-export:` prefix but creator-only raw SQL | Rewrite policy to `assertMember(…, 'orders.manage')`; no `job:` registration is left in orders (verify with grep in a test). |
| Jobs need `declareJobType` | exists (`job-type-registry`) | Declare `orders.recover-stalled-exports`, `orders.expire-exports`, `orders.purge-exports` next to a `JobPayloads` augmentation in `application/order-export.job-types.ts`, imported by the barrel side-effect line like `order.job-types` (so an enqueue-only app loads it). Catch `InvalidScheduleError`; adapt to the discriminated `cancel` result if used. |
| S54 T037 audit comments | none in `orders` (pinned by `orders-boundary.e2e-spec.ts:118`) | New code uses `TransactionRunner.run` only; add the direct-site count assertion for new files. |
| G-54: projector holds `ShopMembershipModel` | `apps/projector/src/projector.module.ts:36,154` registers it; no projector class injects it (only `launch-events` controller/module, not a projector) | **Decision (R1, not R3)**: S12 has no projector that needs membership; the only membership read S12 does is the live-topic policy, which runs in `sse-gateway` through `ShopAccessService.assertMember`. Other consumers that need member lists use `MembershipQueryService.getMembersByShopIds` (as `notifications` already does). Therefore `apps/projector` drops the `SequelizeModule.forFeature([ShopMembership])` registration and the tenancy model import. Proof: grep shows no `@InjectModel(ShopMembership)` reachable from the projector module graph; the projector app must boot (L-018/L-015). If a module in that graph still needs the model, that module migrates to `MembershipQueryService` in this capability's T-task (no model in an app composition, X.1). |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S12-order-export/
├── plan.md            # this file
├── research.md        # Phase 0 decisions
├── data-model.md      # tables, state machine, file, events
├── quickstart.md      # run/verify guide + Ops artifacts
├── contracts/
│   ├── http.md        # routes, DTOs, problem codes
│   └── async.md       # queue, live topic, outbox event, jobs, consumers, config
└── tasks.md           # /speckit-tasks (not created here)
```

### Source Code

```text
packages/contracts/src/orders/
└── order-export.ts                      # six schemas + problem/failure code unions (new)

packages/backend/
├── migrations/2026101*-orders-export-expand.js     # columns, status check, drop FKs, history table, partial unique index (concurrently)
├── migrations/2026101*-orders-export-contract.js   # drop kind, rows, error (after backfill; separate file)
├── db/ownership.ts                                  # + ExportJobHistory: 'domain:orders'
├── scripts/bench/order-export-bench.ts              # AS-12 / SC-001
├── infra/docker/elasticmq/elasticmq.conf            # + order-exports, order-exports-dlq (maxReceiveCount 3)  (L-002, L-020)
├── infra/stack/main.tf                              # + queue pair, user-content lifecycle note
└── libs/domains/orders/
    ├── domain/
    │   ├── export-state.ts(+spec)       # status union, transition table, assertNever
    │   ├── export-csv.ts(+spec)         # encoder, formula guard, BOM/CRLF
    │   ├── export-progress.ts(+spec)    # throttle decision
    │   ├── export-failure.ts(+spec)     # closed classification table, third-delivery rule
    │   ├── export-row.ts                # row type, keyset cursor, legacy fallbacks (title, total)
    │   ├── export-config.ts             # defaults + startup validation
    │   ├── export-errors.ts             # typed domain errors → problem codes
    │   └── export-ports.ts              # EXPORT_JOBS, EXPORT_LINES, EXPORT_FILES, EXPORT_SKUS ports + tokens
    ├── application/
    │   ├── order-export.service.ts      # DELETED, replaced by:
    │   ├── order-export-command.service.ts   # start, cancel, download (audit line)
    │   ├── order-export-query.service.ts     # read, list (keyset)
    │   ├── order-export-run.service.ts       # claim, stream, fence, finish, shutdown release
    │   ├── order-export-maintenance.service.ts # recover, expire, purge, shop events effects
    │   └── order-export.job-types.ts         # declareJobType x3
    ├── infra/
    │   ├── export-job.repository.ts     # conditional transitions + history + outbox append in one tx
    │   ├── export-line.reader.ts        # keyset async generator over ShopOrder/BisOrder/BisOrderItem
    │   ├── export-file.sink.ts          # per-attempt key, put w/ abort + inactivity, promote, delete
    │   ├── export-sku.adapter.ts        # R1 getProductsByIds ≤500, shopId-scoped
    │   ├── order-export.consumer.ts     # queue consumer (bodySchema {exportId})
    │   ├── order-export.jobs.ts         # three scheduled handlers
    │   ├── order-export.tenancy.consumers.ts # offboarding_started, shop_deleted (Projector, inbox)
    │   └── models/export-job.model.ts, export-job-history.model.ts (not exported)
    ├── api/order-export.controller.ts, order-export.dto.ts, order-export-topics.ts
    ├── order-export.module.ts (core) · order-export-worker.module.ts · order-export-topics.module.ts
    ├── rate-limit-policies.ts           # + 'orders.export-start.shop' 5/h fail closed
    └── order-export*.e2e-spec.ts (5)    # per test-plan.md

# Edited: libs/domains/orders/index.ts (barrel), orders-boundary.e2e-spec.ts (allow-list shrinks),
# libs/domains/catalog-sync/{api/catalog-import.controller.ts, catalog-import.module.ts, infra/catalog-import.worker.ts,
#   catalog-import.e2e-spec.ts}, apps/core, apps/worker, apps/sse-gateway, apps/projector (G-54),
# docs/spec/capabilities/S12-order-export.md (new page), docs/work/architecture/debt-register.md (D-10 row)
```

**Structure Decision**: one new layered slice inside the existing `orders` domain; three Nest modules matching the three deployables; nothing of the slice is exported from the barrel except the modules. Old files are deleted outright.

## Design decisions that go beyond spec.md (details in research.md)

1. **Per-attempt object + promote.** The sink writes to `exports/<shopId>/<exportId>/attempt-<n>-<leaseToken>.csv`; completion is one fenced transaction (`UPDATE … WHERE status='RUNNING' AND leaseHolder=:me AND leaseExpiresAt>now()` + history + outbox), the winning attempt's key is written to the row's internal `fileKey` **in that same transaction** (never returned by the API). There is no copy or rename: the fenced commit is the promotion. A loser (cancel won, fenced, failed) deletes its own attempt object; an attempt object that no row points to (worker died before commit) is invisible and is removed by the storage lifecycle rule (one day) and by the recovery job, which deletes `exports/<shopId>/<exportId>/attempt-*` other than `fileKey` when it requeues.
2. **Fencing token = `leaseHolder` (uuid per claim)** plus `attempt`; every counter write, heartbeat and completion carries it in the predicate (AS-50).
3. **Cancel observation**: the worker checks cancellation at each batch boundary and at each heartbeat by re-reading the row with its token; an `AbortController` aborts the in-flight `put`.
4. **Connection discipline**: the reader runs one short `SELECT … LIMIT 1000` per batch through the pool (no transaction); `pg_stat_activity` is assertable between batches (AS-10).
5. **Backpressure bound**: reader is an async generator pulled by `Readable.from` with `highWaterMark: 1` batch-objects and a row-mode transform with `highWaterMark` sized so read-ahead ≤ 3,000 lines (1 batch in flight + 1 batch in the transform + 1 in the encoder buffer).
6. **Rate limit counted per start**, policy `orders.export-start.shop`; a refusal by the one-active rule does not need to refund (spec AS-26 counts started exports).
7. **Tenancy events**: two `Projector`s with `idempotency: 'inbox'`, patterned on `catalog-sync/infra/tenancy-events.consumer.ts`; `shop_deleted` first cancels active exports then deletes files, rows and history in bounded chunks.
8. **Download audit** is a structured log line (`order_export_downloaded`), never the link.
9. **Cutover order** (no window where two things consume): S12 adds queue + routes and removes the `kind:'export'` branch in the same change; `catalog-sync` files are edited only for the export lines (S07 owns the rest; coordinate via gaps.md follow-up).

## Order of work (feeds `/speckit-tasks`)

1. **Reconcile** (gaps §D.1): run `check:table-ownership` and `check:boundaries` baselines for `orders` and `catalog-sync`; reconcile section C.
2. **Living spec first** (cross-spec rule 0): create `docs/spec/capabilities/S12-order-export.md` with rules/behaviours and `[proof:]`/`[code:]` markers (none of the code exists yet: add `[code:]` as each file lands; `check.py` must stay green). Edit nothing under `*.reviewed.json`.
3. **Contracts** (A5) + e2e skeletons that fail first.
4. **Domain** pure modules + unit specs (AS-13, 14, 16, 35, 61).
5. **Migration** expand (+ ownership entry), model classes, repository; **contract migration** last.
6. **Infra** reader, sink (extend `ObjectStorage.put` with `signal` and `inactivityTimeoutMs` options; make the in-memory `abortMultipartUpload` real — A20), SKU adapter, consumers, jobs, topic policy.
7. **Application + API**; rate-limit policy; config validation.
8. **Wiring** (core, worker, sse-gateway), queue declarations in `elasticmq.conf` and Terraform, queue readiness (L-002, L-020), **boot each app standalone** (L-015, L-018).
9. **Remove** old service, `realtime-topics*.ts`, barrel lines, `catalog-sync` references and its e2e case; shrink the boundary allow-list; drop the projector membership registration (G-54).
10. **Prove**: per-file e2e via `test-spec.sh`, then the capability suite once; benchmark; `check.py`; `fresh-run.sh` for the empty stack (L-012); debt row D-10 → `resolved (S12, S07)` (only the S12 half is verifiable here: see gaps.md follow-ups).

## Known-failure-class guard (from the invocation)

| Lesson | Applied as |
|---|---|
| L-001 | Queue `order-exports` is standard: `enqueue` never passes `groupId`/`dedupeId`; delay only via `delaySeconds ≤ 900` (backoff 60 s ± 20 %). |
| L-002/L-020 | Queue + DLQ added to `elasticmq.conf` and Terraform in the same change; worker readiness fails while `queueExists('order-exports')` is false; quickstart lists the queue-server reload command. |
| L-003 | No "A or B" assertions; storage/DB limits are reported blocked, not weakened. |
| L-004/L-015/L-018 | Real `core`, `worker`, `sse-gateway`, `projector` each started standalone before sign-off (quickstart §3). |
| L-005/L-006 | Every e2e creates its own shop, orders and exports; none relies on seeded data or order of files. |
| L-008 | Large cases (50,000 lines, 25,000) run in their own file/batch; summary line checked. |
| L-010 | Start is idempotent by key and by the one-active rule (409 + `activeExportId`). |
| L-011 | Tables `ExportJob`, `ExportJobHistory` created by migration and listed in `ownership.ts`; the object bucket and queue exist in the test stack. |
| L-013 | Fault-injecting tests (failing storage, killed worker) clean up aborted uploads and requeue state in `afterEach`. |
| L-016 | The recovery/cleanup jobs never throw on the condition they repair (a refused storage delete is logged and retried next run). |
| L-017 | Scenario IDs (AS-nn) are kept in test titles; the deleted `catalog-import.e2e-spec.ts:120-128` case survives as AS-04/AS-05. |
| L-019 | Runtime proofs (app boots, empty-stack run) are in quickstart §3 and run by the final checkpoint script, not left to a builder pass. |

## Complexity Tracking

None. (Transitional barrel lines are *removed*, not added.)

## Post-design Constitution re-check

Design adds no direct `sequelize.transaction`, no cross-domain table, model, FK or association, no new domain edge (`orders → catalog` and `orders → tenancy` already exist; `catalog-sync → orders` removed), and keeps every pure rule free of framework/clock/I/O imports. All gates pass.
