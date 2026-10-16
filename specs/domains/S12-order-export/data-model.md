# Data Model: S12 — Order Export

Owner of both tables: `domain:orders` (`packages/backend/db/ownership.ts`: `ExportJob` exists, add `ExportJobHistory`). No foreign keys to `Shop` or `User` (IX.4); `shopId` and `createdBy` are plain UUIDs.

## `ExportJob` (existing table, expanded)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK (`uuidv7()`) | `exportId` in the API |
| `shopId` | uuid not null | every read has it in the predicate (FR-028) |
| `createdBy` | uuid not null | plain user ID |
| `status` | text, CHECK in (`QUEUED`,`RUNNING`,`DONE`,`FAILED`,`CANCELLED`,`EXPIRED`) | widened from four values; default `QUEUED` |
| `attempt` | int not null default 0 | incremented at claim; restored by graceful release |
| `totalRows` | bigint null | counted once per run, bounded by `createdAt` |
| `rowsWritten` | bigint not null default 0 | ← backfilled from `rows` |
| `bytesWritten` | bigint not null default 0 | |
| `failureCode` | text null | closed set (see contracts/http.md); ← backfilled from `error` as `internal_error` where `status='FAILED'` |
| `fileKey` | text null | internal: winning attempt's object key; never in a DTO or log |
| `leaseHolder` | uuid null | fencing token of the current claim |
| `leaseExpiresAt` | timestamptz null | |
| `startedAt`, `finishedAt`, `expiresAt` | timestamptz null | `expiresAt = finishedAt + 7 d` on `DONE` |
| `createdAt`, `updatedAt` | timestamptz not null | `updatedAt` also marks the last requeue (unclaimed-recovery clock) |

Dropped in the contract migration (after the app no longer reads them): `kind`, `rows`, `error`, `objectKey`, and the foreign keys `ExportJob_shopId_fkey`, `ExportJob_createdBy_fkey` (the FKs are dropped in the **expand** step because new inserts must not depend on them).

Indexes:
- `ux_exportjob_active_per_shop` UNIQUE on (`shopId`) WHERE `status IN ('QUEUED','RUNNING')` — created `CONCURRENTLY`, outside a transaction (FR-003).
- `ix_exportjob_shop_created` on (`shopId`, `createdAt` DESC, `id` DESC) — list keyset.
- `ix_exportjob_lease` on (`leaseExpiresAt`) WHERE `status='RUNNING'` — recovery.
- `ix_exportjob_finished` on (`finishedAt`) WHERE `status IN ('DONE','FAILED','CANCELLED','EXPIRED')` — expiry/purge.

Migration rules (III.11): `SET lock_timeout`, additive first; backfill in batches; existing rows with `status` in the old four values stay valid; legacy `RUNNING` rows get `leaseExpiresAt = now()` so recovery handles them.

## `ExportJobHistory` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `exportId` | uuid not null | no FK (ownership: same domain, but kept loose so purge order is free); index (`exportId`, `at`) |
| `shopId` | uuid not null | for shop deletion |
| `fromStatus` | text null | `null` for creation |
| `toStatus` | text not null | |
| `reason` | text null | `retry`, `lease_expired`, `retention`, `shop_offboarding`, `shutdown`, `attempts_exhausted`, … |
| `actor` | uuid null | user ID, `null` = system |
| `at` | timestamptz not null | injected clock |

One row per transition, written in the same transaction as the conditional update (FR-002).

## State machine (`domain/export-state.ts`)

```
QUEUED ──claim──▶ RUNNING ──▶ DONE ──retention──▶ EXPIRED
  │ ▲                │ │
  │ └─retry/lease/──┘ ├──▶ FAILED
  │   shutdown          └──▶ CANCELLED
  └──cancel──▶ CANCELLED
```

Allowed pairs exactly: QUEUED→RUNNING, QUEUED→CANCELLED, RUNNING→DONE|FAILED|CANCELLED|QUEUED, DONE→EXPIRED (AS-61). Terminal: FAILED, CANCELLED, EXPIRED. `CANCELLED→CANCELLED` is an API no-op, not a transition. A `switch` over the status union ends in `assertNever`.

## Pure value types (`domain/`)

- `ExportRow { orderId, shopOrderId, createdAt: Date, shopOrderStatus, currency, productId, sku: string|null, title, quantity: number, unitPriceMinor: string, discountMinor: string, lineTotalMinor: string }` — money as decimal strings.
- `KeysetPosition { createdAt: string(ISO ms), shopOrderId, lineId }` and the opaque list cursor `{createdAt, id}` (base64url JSON, strict-parsed → `invalid_cursor`).
- `FailureCode`, `Classification = { retry: boolean, code: FailureCode }`.
- `ProgressDecision(now, lastEventAt|null, isLast) → boolean`.

## Ports (`domain/export-ports.ts`, injected by token)

`EXPORT_JOBS` (create-with-active-guard, claim, heartbeat, record progress, finish+outbox, release/requeue, cancel, list/get by shop, recovery scans, expiry/purge selects, delete-by-shop), `EXPORT_LINES` (`count(shopId, until)`, `batches(shopId, until, position)`), `EXPORT_FILES` (open sink with abort, delete, head size, presign), `EXPORT_SKUS` (`lookup(shopId, productIds ≤ 500) → Map<id,{sku,title}>`), `CLOCK`, realtime `EXPORT_LIVE` (fire-and-forget publish), `EXPORT_QUEUE` (enqueue).

## File (`orders-<exportId>.csv`)

UTF-8 BOM, header `order_id,shop_order_id,created_at,shop_order_status,currency,product_id,sku,title,quantity,unit_price_minor,discount_minor,line_total_minor`, CRLF records, RFC 4180 quoting, formula guard on `sku` and `title`, `created_at` ISO-8601 UTC ms (the **shop order's** creation time), order (shop-order `createdAt`, shop-order `id`, line `id`). Object key `exports/<shopId>/<exportId>/attempt-<n>-<token>.csv`.

## Events

`order_export.finished` v1 — see [contracts/async.md](contracts/async.md).
