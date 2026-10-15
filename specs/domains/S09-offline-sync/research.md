# Research: S09 design decisions

Format: Decision / Rationale / Alternatives. Facts checked in the tree on 2026-10-15.

## R-01 Claim-first idempotency, no catalog call in a transaction (A6, FR-003/005, AS-02/03/13/14)
- **Decision**: per operation: (1) `INSERT … ON CONFLICT (shopId, opId) DO NOTHING` committing a `pending` row with fingerprint, content, `claimedAt`; (2) on conflict read the row: same fingerprint + done → `replayed: true` with stored result; different fingerprint → `op_id_reused`; `pending` younger than 60 s → `retry/in_flight`; older → takeover by conditional `UPDATE … SET claimedAt = now WHERE claimedAt = :seen` (one winner); (3) call the catalog with ID `sync:<shopId>:<opId>`; (4) one transaction writes result + (for conflicts) `SyncConflict` + outbox row. A crash after (3) is repaired by repeat: the catalog's own per-ID idempotency returns `replayed: true` with the original `quantityAfter`, and the result is recorded with `replayed: false` for the device (the sync operation had not completed).
- **Rationale**: the catalog call opens its own transaction; holding ours open across it would be a cross-owner transaction (IX.4) and a pool-starvation risk. Deterministic IDs make step 3 safe to repeat.
- **Alternatives**: single transaction across both owners (today; rejected, IX.4); inbox table keyed by op (same as claim row, no gain).

## R-02 Content fingerprint
- **Decision**: SHA-256 hex over canonical JSON of `{type, productId, hlc, payload}` (sorted keys); stored beside the content needed to complete the operation (`content` jsonb). `deviceId` is not part of the fingerprint (a resend from another install of the same queue is the same operation).
- **Rationale**: AS-04 needs a cheap equality; the stored content lets the recovery job complete a claim with no client present.

## R-03 Clamping an oversold delta (FR-013, AS-08/09/10)
- **Decision**: `applyStockDelta([{operationId, delta}])`. On `rejected/insufficient_stock` read quantity with `getProductsByIds(ids,{shopId})`, `applied = max(delta, −quantity)`; if `applied ≠ 0` issue `applyStockDelta` with `…:clamp` (≤3 attempts on a race; each attempt re-reads). Result `conflict{oversold, requested, applied, shortfall}`; `quantity_limit` → no second call, `conflict{quantity_limit, applied: 0}`. `unavailable` → `product_unavailable`; `not_found` → `unknown_product` (same body as foreign: the S05 `not_found` already hides foreign shops).
- **Rationale**: keeps S05's all-or-nothing contract; replaces S05's stopgap row-lock clamp in legacy `applyOp`. AS-08's concurrency is decided by the catalog's row lock, so exactly one of two last-unit sells applies.
- **Alternatives**: ask S05 for a clamp mode (rejected in questions.md).

## R-04 Per-field LWW serialisation (A5, FR-018, AS-18)
- **Decision**: decisions for one product are serialised by a **session-level advisory lock** (`pg_try_advisory_lock(hashtextextended('sync-field:'||shopId||':'||productId, 0))`, polled with short sleeps up to the push budget, released in `finally`) held on a dedicated pooled connection by a `ProductEditLock` port. Under the lock, on other connections: read the product's clocks (`WHERE shopId AND productId`) and the product version through the catalog → decide with the pure function → if any field wins, `ProductCommandService.update(shopId, productId, {expectedVersion, …winning fields})` (≤3 attempts on `VersionConflictError`, then `retry/contention`; `ProductValidationError` → `rejected/invalid_field`, `ProductArchivedError` → `product_unavailable`, not found → `unknown_product`) → upsert the winning clocks in a short transaction (`INSERT … ON CONFLICT (shopId, productId, field) DO UPDATE SET hlc = EXCLUDED.hlc WHERE "ProductFieldClock".hlc < EXCLUDED.hlc`) → release.
- **Rationale**: the catalog call must not run inside a transaction of ours (R-01), yet two edits of one field must not both see a stale clock (A5: with no clock row, `FOR UPDATE` locks nothing). A lock that is not a transaction satisfies both; it uses `sequelize.query` on a checked-out connection, not `sequelize.transaction`, so the S54 audit count stays 0. If the process dies the connection closes and Postgres frees the lock. A clock written only after the catalog accepted the value means a refused value advances no clock (AS-22); a crash between the two leaves the value stored with an older clock, healed by the recovery job re-running the stored operation (idempotent: same values → catalog no-op update, S05.R-08, then the clock is written).
- **Alternatives**: `FOR UPDATE` on clock rows (no row on first edit); reserving the clock before the catalog call (a clock without a value on refusal); advisory transaction lock around the catalog call (S05's `runner.run` joins the active CLS transaction, which would make one transaction span two owners).
- **Verify first (task)**: `ProductEditLock` takes its connection outside the CLS transaction scope, so the catalog call is never inside one of ours; AS-18 ×20 with `Promise.all`.

## R-05 Feed as a read model (A17, FR-024, AS-26/27/29)
- **Decision**: projector `catalog-sync-offline-feed` consumes `catalog.product_created|updated|archived|restored|deleted` via the projections framework with `natural` idempotency: in one transaction lock `ShopSyncState` row (`SELECT … FOR UPDATE`, upsert on first use), skip if an entry with `version ≥ event.version` exists for `(shopId, productId)` (index `(shopId, entityId, version DESC)`), else `seq = lastSeq+1`, insert entry, update `lastSeq`. The counter-row lock serialises writers, so a rolled-back transaction leaves no gap and a visible `seq` implies all smaller ones are committed.
- **Rationale**: gap-free by construction; duplicates are a unique index `(shopId, entityId, version)` plus the version guard; no trigger on the catalog's table.
- **Alternatives**: Postgres sequence (gaps on rollback, visibility holes); keeping the trigger (IX.4 forbids).

## R-06 Generation, horizon, resync (FR-027/028, AS-32/55)
- **Decision**: `ShopSyncState(shopId, lastSeq, generation int, horizonSeq bigint, horizonAt)`. Cursor = base64url(`v1.<shopId>.<generation>.<seq>`) + 8-byte HMAC (secret from config, same helper as S08's cursor if exported, else local). `410 resync_required` when generation differs, `seq > lastSeq`, or `seq < horizonSeq` (compaction removed entries the device could need: compaction sets `horizonSeq` to the highest removed `seq` and `horizonAt`). Tombstone retention equals the compaction age (30 d). Pull without cursor = bootstrap: page through `listByShop`? No — read from the feed itself: newest entry per product (`DISTINCT ON (entityId) … ORDER BY entityId, version DESC`) paged by `seq`, returning the generation's `lastSeq` at start as the continuing cursor. Deleted products appear as tombstones within the horizon.
- **Rationale**: compaction never needs `listByShop`; that port method is used only by the backfill (R-07).

## R-07 Backfill and new generation (LOCAL decision, questions.md)
- **Decision**: a one-off `backfillShop(shopId)` in the projector module (invoked by a job `catalog-sync.backfill-change-log`, declared like the others, enqueued once per shop by the contract migration's data step? **No**: enqueued lazily at first pull/bootstrap of a shop whose `ShopSyncState` is absent or `generation = 0`). It increments `generation`, pages `ProductCommandService.listByShop`, writes entries with the product's `version`, and continues with normal events (version guard keeps newer ones). Old cursors answer `410`.
- **Rationale**: the existing feed was trigger-built with no versions; reusing it would give entries without `version`.
- **Adds**: a fourth job name beyond the three in Provides; internal, not contract (noted in `contracts/events-and-jobs.md`).

## R-08 Server clock (A13, FR-022, AS-23)
- **Decision**: `ServerHlc` service per instance, node `server-<instanceId>` (instance id from config, default hostname+pid), `tick` on each response with `CLOCK.now()`, `receive` for each accepted op clock, monotonic under a mutex-free single-threaded update. `serverHlc` = max of ticked value and every accepted op clock + 1 logical.
- Rejected ops (implausible, invalid) do not call `receive` (AS-19).

## R-09 Plausibility, expiry, validation order
- **Decision**: per operation: schema (`invalid_op`) → clock decode (`invalid_hlc`) → node vs header (`hlc_node_mismatch`) → expiry by `hlc.physical < now − 30 d` (`op_expired`, all types) → for `product.update` only: `physical > now + 60 s` (`clock_implausible`) → claim. Rejected operations are **also recorded** (so a replay returns the same body and `op_id_reused` holds), except schema failures with no usable `opId`.
- **Rationale**: AS-04/34 need an `opId`-scoped memory of rejections; envelope errors never reach this path.

## R-10 Deadline and failure (FR-008, AS-37/38)
- **Decision**: loop checks `clock.now() − start ≥ budget` before starting each operation (budget from config, default 20 s); remaining → `retry/deadline_exceeded` and **not recorded**. A thrown store error is mapped to `503 sync_unavailable` (generic body, no detail) by a `SyncUnavailableError`; earlier operations are already durable (own commits). Faults in tests: a Postgres rule/trigger on `SyncOperation` that raises once (real mechanism); slow store via `pg_sleep` in a rule.

## R-11 Rate limits, body size, headers (FR-034, FR-035, AS-35/36)
- **Decision**: policies added to `catalogSyncRatePolicies` (same file as S08): `catalog-sync.sync-push.device` (30/min), `catalog-sync.sync-pull.device` (120/min), `catalog-sync.conflict-write.shop` (60/min), `slidingWindow`, `failMode: 'closed'`; key `device` requires checking how S50 keys: if only `shop|user|ip|apiKey` exist, the device key is composed as `shopId:deviceId` via the `subject` resolver S50 offers (verify in T-rate-0; otherwise a documented extension request to S50 goes in gaps.md). Body limit: route-scoped `json({limit:'2mb'})` via the existing S54 body-limit mechanism (verify name) answering `413 payload_too_large`.
- `RateLimitModule.forFeature(catalogSyncRatePolicies)` is already imported by S08 modules; `OfflineSyncModule` imports it too (L-018).

## R-12 Authorization and tenancy (FR-032/033, AS-42–47)
- **Decision**: `@ShopScoped('products.write'|'products.read')` as today; `userId` from the principal, `deviceId` from the header pipe; `ops[i]` schemas `.strict()` so `shopId/userId/deviceId` fields fail as `invalid_op`. Conflict dismissal and listing predicates carry `shopId`; the foreign `opId` returns `404 not_found`.

## R-13 Events and conflicts (FR-030)
- **Decision**: `catalog_sync.offline_conflict_opened` v1 defined next to S08's events in `application/events/` with `CATALOG_SYNC_AGGREGATE` (topic `catalog-sync.events`), key `opId`; `outbox.append` inside the result-recording transaction. Unique `SyncConflict(shopId, opId)` makes a re-recorded result create no second conflict or outbox row.

## R-14 Lifecycle consumers (FR-036, AS-48/49)
- **Decision**: `tenancy.shop_deleted` → delete the shop's `SyncConflict`, `SyncOperation`, `ShopChangeLog`, `ProductFieldClock`, `ShopSyncState` in batches ≤1,000 rows (like S08's `ShopPurgeRepository`; reuse S08's consumer registration pattern, separate consumer name); `catalog.product_deleted` → delete clocks `WHERE shopId AND productId`. Both idempotent by nature (delete is a no-op the second time); invalid payload → framework DLQ.

## R-15 Jobs (FR-005/028/037)
- **Decision**: `catalog-sync.redrive-stale-ops` (every minute; claims older than 5 min; completes each through the same `apply` path with stored content, per-row conditional takeover so two instances finish each once), `catalog-sync.compact-change-log` (daily; per shop in batches, sets horizon), `catalog-sync.purge-sync-operations` (daily; ops older than 90 d except those with an open conflict; dismissed conflicts cascade by application delete in the same statement batch, not by FK). `declareJobType` with `z.object({}).strict()` contracts next to the `JobPayloads` augmentation (S49 follow-up). `InvalidScheduleError` caught at registration. `JobsService.cancel` unused.

## R-16 Migration shape (A7, A16, A23, A17)
- **Expand** (`lock_timeout`): add columns (`SyncOperation.userId, fingerprint, content, claimedAt, status text, code, quantityAfter, productVersion, expiresAt`), unique index `(shopId, opId)` (built `CONCURRENTLY` in its own migration file), `SyncConflict`, `ShopChangeLog.version/deleted`, `ShopSyncState.generation/horizonSeq/horizonAt`, `ProductFieldClock.shopId` (backfilled by reading nothing foreign: rows whose product is unknown to us keep `shopId` from the old `SyncOperation` that created them where available, else are deleted — they are unusable without a shop and rebuilt by next edit; stated in `data-model.md`).
- **Contract** (separate file, after code no longer uses them): drop trigger/function, drop FK + cascade, drop old primary key `opId`. A `test/data-migration`-style e2e (existing pattern in `catalog-sync/test/`) proves the migration on a populated table.

## R-17 Observability (FR-039, AS-51)
- **Decision**: metrics via the registry used by `sync-metrics.ts` of S08: `catalog_sync_offline_ops_total{type,status}`, `catalog_sync_offline_push_duration_seconds`, `catalog_sync_offline_feed_lag_seconds` (age of oldest unprocessed product event, computed by the projector from `occurredAt` of the last handled event vs now, plus a sampled gauge), `catalog_sync_offline_conflicts_open`, `catalog_sync_offline_ops_in_flight`. Logs: one structured line per operation with ids and codes only.

## R-18 Test fixtures (D-7, L-005, L-006)
- Tests use the shared fixture helpers of S08 (`test/utils/s08-tenancy-fixture.ts`, re-exported) and S05's services; each test creates its own shop and products (`createIsolatedProduct`); no `ProductModel`/`ShopModel`.

## R-19 Living spec (rule 0)
- No `docs/spec/capabilities/S09-*.md` exists. Phase 0 creates it following S08's page format (id/title/depends_on/concepts/scope front matter, Entry points, Rules, Behaviors with `[proof:]`/`[code:]` that `check.py` verifies); no `*.reviewed.json` is created or edited. No human-signed page is changed by S09 (the S08 page is only mentioned in gaps.md follow-ups).
