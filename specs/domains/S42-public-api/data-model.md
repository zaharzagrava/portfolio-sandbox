# Data model: S42 — Seller public API

Owner of every table below: `domain:developer-platform` (`packages/backend/db/ownership.ts`; `ApiKey` and `ShopApiSettings` already registered, the three new tables are added with the migration). No foreign key to another owner's table (IX.4); IDs are plain columns. Timestamps come from the injected clock.

## 1. Tables after the change

### `ApiKey` (reshaped)

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | `uuidv7` |
| `shopId` | uuid, not null | live shop; **no FK** (dropped) |
| `prefix` | varchar(12), unique | public part; collision → regenerate (≤ 5) |
| `hash` | bytea/varchar | keyed hash of the secret; never returned, never in an event or log |
| `hashVersion` | smallint default 1 | 1 = current pepper, 0 = previous (re-hash on use) — values are labels, the pepper values live in config |
| `name` | varchar(60) | 1–60 |
| `scopes` | text[] | distinct subset of `products:read`, `products:write`, `stock:write`, `orders:read`, ≥ 1 |
| `livemode` | boolean | fixed at creation |
| `createdBy` | uuid | audit only; **no FK** (dropped) |
| `expiresAt` | timestamptz null | future, ≤ 365 d at creation; set on rotation of the old key |
| `successorId` | uuid null (**new**) | set once by the conditional rotate |
| `rotatedAt` | timestamptz null (**new**) | when rotation happened |
| `revokedAt` | timestamptz null | set once |
| `lastUsedAt` | timestamptz null | monotonic write-behind |
| `createdAt` | timestamptz | |

Indexes: unique `(prefix)`; `(shopId, createdAt DESC, id)` for the list; partial `(shopId) WHERE revokedAt IS NULL` for the limit count.

### `ShopApiSettings` (reshaped)

`shopId` uuid PK (**no FK**), `pinnedVersion` varchar(10) not null, `pinnedAt` timestamptz null (**new**; backfilled from `updatedAt`), `updatedAt`. This row is also the per-shop serialisation point of key creation (research R-02).

### `ApiBulkJob` (new)

| Column | Type | Rule |
|---|---|---|
| `id` | varchar(36) PK | `bsu_` + 32 hex |
| `shopId` | uuid, not null | every read/update has it in the predicate |
| `total` | int | 101–10,000 |
| `chunks` | int | `ceil(total/100)` |
| `completedChunks`, `applied`, `replayed`, `failed` | int default 0 | updated only in the chunk transaction that flips the marker |
| `failures` | jsonb default `[]` | first 1,000 `{operation_id, product_id, outcome}` |
| `status` | varchar | derived/stored: `processing`, `succeeded`, `partially_failed`, `failed` |
| `createdAt`, `expiresAt` | timestamptz | `expiresAt = createdAt + 7 d` |

Index `(shopId, id)`, `(expiresAt)` for the purge.

### `ApiBulkChunk` (new)

`(jobId, index)` PK, `shopId`, `state` (`pending|done|failed`), `result` jsonb null, `completedAt`. Items live in the queue message, not here (bounded by 100 items × ~70 bytes); the message is the retry source until `done`.

### `ApiUsageBucket` (new)

`(shopId, minute, sequence)` PK, `quantity` int ≥ 1, `emittedAt` timestamptz null, `eventId` uuid null (deterministic). Open bucket = row with `emittedAt IS NULL`. Index `(emittedAt) WHERE emittedAt IS NULL` for the closer.

### Not stored here

Request records (ClickHouse `api_requests`, 30-day TTL, keyed `(shopId, requestId)`; additive columns `clientRequestId`, `errorCode`, `batchOps`, `idempotentReplay`, `deprecated`), version and deprecation registries (code), key cache entries and tombstones (Redis), idempotency records (shared store), outbox rows (S53).

## 2. Key status (derived, `domain/key-status.ts`)

| Condition (evaluated in this order, injected `now`) | Status |
|---|---|
| `revokedAt IS NOT NULL` | `revoked` |
| `expiresAt IS NOT NULL AND expiresAt <= now` | `expired` |
| `successorId IS NOT NULL` | `rotating` |
| otherwise | `active` |

Transitions: `active → rotating` (rotate), `active|rotating → revoked` (revoke; repeat = no-op `204`), `active|rotating → expired` (time only). Anything else answers `409 key_revoked | key_expired | key_already_rotating`.

## 3. Bulk job status

`processing` while `completedChunks < chunks`; then `succeeded` (failed = 0), `failed` (applied + replayed = 0), else `partially_failed`. `failed` counts items whose outcome is not `applied|replayed` (`not_found`, `insufficient_stock`, `conflict`).

## 4. Migrations (timestamps assigned at implementation, after the latest existing one)

Every statement runs with `lock_timeout = '3s'`; each migration is idempotent (`IF [NOT] EXISTS`) and has a `down`.

1. **expand**: `ApiKey.successorId`, `ApiKey.rotatedAt`, `ApiKey.hashVersion`; `ShopApiSettings.pinnedAt`; create `ApiBulkJob`, `ApiBulkChunk`, `ApiUsageBucket`; indexes; ClickHouse DDL for the additive columns (run by the ClickHouse migration mechanism the repo uses for `api_requests`).
2. **contract (FKs)**: drop `ApiKey.shopId → Shop`, `ApiKey.createdBy → User`, `ShopApiSettings.shopId → Shop` constraints (names read from the catalog, dropped `IF EXISTS`). `Shop.sandboxOf` is S03's and untouched.
3. **registry**: entries for `ApiBulkJob`, `ApiBulkChunk`, `ApiUsageBucket` in `db/ownership.ts`; `check:model-registry` and `check:table-ownership --strict` pass.

No data backfill other than `pinnedAt`. The old `bulkstock:<id>` Redis hashes expire by their TTL (24 h); a job in flight during deploy answers `404` afterwards — listed in `quickstart.md` as an operator note.

## 5. Validation rules (from the spec)

| Field | Rule |
|---|---|
| key `name` | trimmed, 1–60 |
| `scopes` | 1–4, distinct, members of the four |
| `expiresAt` | future, ≤ 365 days |
| `overlapHours` | integer 0…168 |
| `price` (latest) | `{amount: int 1…max, currency: platform currency}`; `0`, negative, fractional, other currency refused |
| `Idempotency-Key` | 1–255, charset of the shared store |
| bulk item | `operationId` 1–128 unique in request, `productId` id format, `delta` non-zero int, `|delta| ≤ 1,000,000`; ≤ 10,000 items |
| batch | 1–50 operations, each validated by the schema of its route; not batchable: `/v1/batch`, `/v1/stock/bulk` over 100 items, `GET /v1/stock/bulk/:jobId` is allowed read |
| `limit` | integer 1…100, default 20 |
| `expand` | only `shop`, ≤ 3 values, depth 1 |
| cursor | opaque base64url of `{v:1, k:[…]}` with an HMAC; invalid → `400 invalid_cursor` |
| job id | `^bsu_[0-9a-f]{32}$` |

## 6. Cursors

Products and orders: the keyset of S05/S10 (opaque, unique tiebreaker) is wrapped in this API's own cursor (versioned, signed with the `api_key_pepper`-derived subkey) so a client cannot hand-craft one. Logs: `(ts DESC, requestId)`. Keys list: `(createdAt DESC, id)`.
