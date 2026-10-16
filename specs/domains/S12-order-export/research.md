# Research: S12 — Order Export

Phase 0. All unknowns of the Technical Context are resolved here; code facts were checked in the tree on 2026-10-16.

## R-01 Read strategy: keyset batches as an async generator
- **Decision**: one `SELECT` per batch of 1,000 lines, `WHERE so."shopId" = :shop AND so."createdAt" <= :requestedAt AND (so."createdAt", so.id, i.id) > (:t, :soId, :lineId) ORDER BY so."createdAt", so.id, i.id LIMIT 1000` over `ShopOrder` ⋈ `BisOrder` ⋈ `BisOrderItem` (item `shopId` = shop order `shopId`), hand-written in `infra/export-line.reader.ts`. Exposed as `AsyncGenerator<ExportRow[]>`, piped with `Readable.from` → encoder transform → `ObjectStorage.put`, all in `stream.pipeline`.
- **Rationale**: no pinned connection or snapshot (III.3/III.10), resumable position, fenceable, memory flat; row-value comparison uses the existing (shop, createdAt, id) index S10 promised (verify the index exists; add in the expand migration if not).
- **Alternatives**: server-side cursor (pg-query-stream) — rejected: pins a connection and vacuum horizon, cannot be fenced or resumed; `OFFSET` — rejected: quadratic and skips/repeats under inserts.
- **Request time bound**: `requestedAt = job.createdAt` (stored), so lines created later are excluded (FR-016).

## R-02 Title, discount, total, SKU
- **Decision**: title = item snapshot `title`, discount = `discountMinor`, unit = `priceAtPurchase`, total = `lineTotalMinor`. For rows where `title IS NULL` or `lineTotalMinor IS NULL` (legacy, backfill not finished) the reader uses a pure fallback in `domain/export-row.ts`: total = `quantity × unit − discount`; title from the same R1 batch that supplies SKU. SKU = `ProductQueryService.getProductsByIds(ids ≤ 500, {shopId})`, chunked, one call per chunk per batch (AS-07: 700 distinct → 500 + 200), missing product → empty cell. All money is read as `BIGINT` strings and passed through as text (no `Number`), so 9 007 199 254 740 993 survives (AS-03).
- **Rationale**: draft gap A24 (no snapshot) is obsolete: the columns exist. The fallback is needed because the model still declares them nullable.
- **Alternative**: skip legacy rows — rejected: the seller wants the whole history. Fail the export — rejected: data completeness belongs to S10's backfill.

## R-03 Per-attempt object, fenced completion
- **Decision**: see plan §Design decision 1. Key `exports/<shopId>/<exportId>/attempt-<attempt>-<leaseToken>.csv`; `ExportJob.fileKey` set in the completion transaction.
- **Rationale**: one rule for crash, cancel, shutdown and a stale worker (AS-42/45/48/50); needs no object rename (S3 has none).
- **Alternatives**: write final key directly (gap A20) — rejected: a stale worker overwrites B's file. Copy-on-complete — rejected: extra 2.5 GB copy.

## R-04 Storage port extension
- **Decision**: extend `ObjectStorage.put(key, body, contentType, options?)` with `{ signal?: AbortSignal, inactivityTimeoutMs?: number }` (both adapters); on abort or inactivity the multipart upload is aborted and the promise rejects with a `StorageAbortedError`/`StorageStalledError` that `export-failure` maps to `storage_unavailable`. Make `InMemoryObjectStorage.abortMultipartUpload` remove the staged parts and `put` honour `signal`. `delete` stays idempotent. `presignGet` gets the attachment disposition with a safe quoted `filename` (RFC 6266 `filename*`) and chooses the user-content origin when configured (mandatory in production, validated at start-up).
- **Rationale**: needed for AS-33/38/40/50; no S-capability owns the port, S07 extends the same file (keep signatures additive so both merge).
- **Alternative**: wrap in the domain with `Promise.race` — rejected: leaves the upload running.

## R-05 Claim, lease, heartbeat, fencing
- **Decision**: claim = `UPDATE "ExportJob" SET status='RUNNING', attempt=attempt+1, "leaseHolder"=:token, "leaseExpiresAt"=:now+5min, "startedAt"=coalesce(...) WHERE id=:id AND status='QUEUED' RETURNING …` plus history row, in `TransactionRunner.run`. Heartbeat every 60 s extends the lease with `WHERE "leaseHolder"=:token AND status='RUNNING'` and reads back `status` (cancel observation). Counter writes (throttled to ≤ 1/s) carry the same predicate. A worker whose conditional write affects 0 rows stops and aborts its upload (fenced).
- **Graceful shutdown**: the lifecycle registry signals the run's `AbortController`; the run stops at the next batch, aborts, and does `RUNNING → QUEUED` with `attempt = attempt − 1` (token-fenced); the message is left for redelivery (visibility timeout) — no ack.
- **Rationale**: matches S07's numbers (5 min / 60 s / 2 min / 60 s ± 20 %), one set platform-wide.

## R-06 Retry and failure
- **Decision**: only queue redelivery retries. On a classified transient error the run aborts, resets counters, does `RUNNING → QUEUED` (history reason `retry`), re-enqueues nothing itself except by throwing/returning so the queue redelivers after the backoff (use `enqueue` with `delaySeconds` = 60 ± 20 % and ack the current message — chosen because the port's `consume` has no per-message visibility override; one new message per retry, bounded by `attempt < 3`). Third failed delivery (`attempt = 3`) → `FAILED` with the same code. Permanent errors → `FAILED` at once. Classification is a closed table in `domain/export-failure.ts` (AS-35).
- **Rationale**: IV.6; duplicates are harmless because the claim is conditional (AS-43).
- **Alternative**: throw and rely on SQS visibility (delay not controllable, `receiveCount` can burn on deploys) — rejected.

## R-07 Recovery, expiry, purge (S49)
- **Decision**: three cron jobs declared with `declareJobType` (payload `z.strictObject({})`), registered in `OrderExportWorkerModule`, each idempotent and safe under concurrent runs (conditional updates, `FOR UPDATE SKIP LOCKED` batches of 100). Recovery: `RUNNING` with expired lease → `QUEUED` + enqueue, or `FAILED attempts_exhausted` if `attempt ≥ 3`; `QUEUED` older than 2 min with no claim since creation/last requeue (`updatedAt`) → one enqueue (a duplicate is harmless). Expiry: `DONE` with `finishedAt < now−7d` → delete file first, then `DONE → EXPIRED` conditional; a failed delete leaves `DONE` (AS-51). Purge: finished rows older than 90 d, history first.
- **Rationale**: FR-026, FR-031; "never `EXPIRED` while the file exists".

## R-08 Idempotency, one-active rule, rate limit
- **Decision**: `@Idempotent({ttlSeconds: 86400})` on create (S54 interceptor scopes per user and compares method, path, body); the one-active rule is the partial unique index `ux_exportjob_active_per_shop ON "ExportJob"("shopId") WHERE status IN ('QUEUED','RUNNING')`; a unique-violation maps to `409 export_already_active` with `activeExportId` fetched in the same handler; the rate-limit policy `orders.export-start.shop` is checked before the insert (5/h, `failMode: closed`). The enqueue runs after commit; if it fails the job stays `QUEUED` and the 2-minute recovery re-enqueues (documented lost-message path, AS-46).
- **Order of checks**: auth → shop gate/permission → key validation → rate limit → insert (a 409/429 stores nothing under the key; check how the interceptor treats non-2xx — it must not cache errors, per AS-25; add an e2e proving it).

## R-09 Live channel
- **Decision**: `OrderExportTopicsModule` defines prefix `order-export` with an async policy `viewer.userId && await access.assertMember(shopOf(exportId), userId, 'orders.manage')`, catching every error to `false` (identical refusal). `shopOf` reads the job through an `orders` exported-to-itself query service (`ExportJobShopLookup` port in `domain/`), not raw SQL in the policy. Publish through `RealtimePublisher.publish(topic, type, data, {replay})`: `progress` `replay:false`; `done|failed|cancelled` `replay:true`. Every publish is `void`-ed inside a `try/catch` wrapper that logs at most once a minute (AS-17); it never runs inside a database transaction.
- **Rationale**: S51 contract; removed members lose access immediately (S03).

## R-10 Finished event
- **Decision**: `order_export.finished` v1 defined with `defineEvent` (S53) in `application/events/`, topic `order-exports.events`, key `exportId`; `outbox.append` inside the final-status transaction (done in the repository's `finish` method so rollback leaves neither).

## R-11 Tenancy events and G-54 (projector membership)
- **Decision (consumers)**: two `Projector`s (`idempotency: 'inbox'`, `aggregateIdSchema = uuid`) registered by `OrderExportWorkerModule`; payload validated with the tenancy-exported event schemas; invalid → `PermanentError` (dead letter). `offboarding_started` cancels `QUEUED|RUNNING` exports of the shop (reason `shop_offboarding`); `shop_deleted` cancels active, deletes files, then rows and history in chunks; a late `started` after `deleted` finds nothing and returns.
- **Decision (G-54)**: projectors obtain membership data through tenancy's R1 services (`MembershipQueryService.getMembersByShopIds`, `ShopAccessService.assertMember`) — the pattern `notifications` already uses — **not** a local copy (R3) and **not** a model. S12 itself has no projector needing membership. `apps/projector` therefore stops registering `ShopMembershipModel` and stops importing it; if a module in the projector's graph still injects the model, it is migrated to R1 within this capability's task list. Recorded as a sibling follow-up for S53/S03 consumers in gaps.md.
- **Alternative R3 (local membership copy from `tenancy.*` events)** — rejected: projectors would need a replay-safe copy per consumer with no current reader; R1 is already in production use and bounded (≤ 500 ids).

## R-12 Config validation
- **Decision**: `OrderExportConfig` read from the S54 config toolkit; `domain/export-config.ts` holds defaults and a pure `validate()`; failure names the key; invoked in the three modules' `onModuleInit` before the consumer starts (AS-59). User-content origin mandatory when `NODE_ENV=production`.

## R-13 Memory and benchmark
- **Decision**: `scripts/bench/order-export-bench.ts` generates 100 k and 1 M lines (batched `INSERT … SELECT generate_series`) in an isolated shop, runs the real run service against the in-memory/real storage sink, samples `process.memoryUsage().heapUsed` each second, prints time and peak. Not a jest test (SC-001, AS-12): listed in Ops artifacts and `specs/UNVERIFIED.md`.

## R-14 What is not done here
- No filters, formats or offboarding bundle (spec Assumptions). The `nosniff` / separate user-content origin edge test and the storage lifecycle rule for incomplete uploads are infrastructure artifacts (Ops artifacts). W04 UI is not edited.

## Baseline (real run, 2026-10-16)
- `check:table-ownership` (non-strict): `orders` has 1 finding, `SQL Product` in `application/order-export.service.ts` (the `LEFT JOIN "Product"`); matches gaps.md §C. `catalog-sync` has 1 finding (`SQL Product` in `catalog-import.service.ts`), which is S07's and is not fixed here. The others (asset-library, community, content, launch-events, seller-insights, seller-onboarding) are listed, not fixed.
- `check:boundaries`: no dependency violations (3589 modules).

## Follow-ups verified
- S05: `externalSku: string | null` is on `ProductDto` (`catalog/domain/product-view.ts:28,51`): true.
- S10: `BisOrderItem` has `title` (nullable), `discountMinor`, `lineTotalMinor` (nullable): true; legacy fallbacks stay in `domain/export-row.ts`.
- S49: `declareJobType` (`jobs/job-type-registry.ts`) and `InvalidScheduleError` (`jobs/job-errors.ts`) exist: true.
- S51: prefix `order-export` is registered in `orders/api/realtime-topics.ts` with a creator-only policy (replaced in T044): true.
- S53: `Projector` with `idempotency: 'inbox'` is used by `catalog-sync/infra/tenancy-events.consumer.ts`: true.
- G-54: `apps/projector/src/projector.module.ts:36,154` registers `ShopMembership`: true (removed in T073).
