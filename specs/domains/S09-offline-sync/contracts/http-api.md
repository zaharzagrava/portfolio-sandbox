# HTTP contract: offline sync (`/api`, problem+json errors with `code` and `requestId`)

Schemas live in `packages/contracts/src/catalog-sync/offline-sync.ts` (written first; every e2e parses responses with them): `syncPushRequestSchema`, `syncPushResponseSchema` (contains `syncOpResultSchema`), `syncPullResponseSchema`, `syncConflictSchema`, `syncConflictPageSchema`, `syncEventSchemas`. Authoritative field lists: [spec.md](../spec.md) "Provides". Summary:

| Route | Permission | Header | Success | Errors |
|---|---|---|---|---|
| `POST /shops/:shopId/sync/push` | `products.write` | `X-Device-Id` (4–64 of `[A-Za-z0-9_-]`) | `200 {results, serverHlc}` | `400 validation_failed`, `413 payload_too_large` (>2 MiB), `401`, `403 permission_denied`, `403 shop_suspended`, `409 shop_offboarding`, `404 not_found`, `429 rate_limited` + `Retry-After`, `503 sync_unavailable` |
| `GET /shops/:shopId/sync/pull?cursor&limit` | `products.read` | `X-Device-Id` | `200 {changes, cursor, hasMore, serverHlc}`, `Cache-Control: no-store` | `400 invalid_cursor`, `400 validation_failed`, `410 resync_required`, `401`, `404`, `429` |
| `GET /shops/:shopId/sync/conflicts?status&limit&cursor` | `products.read` | — | `200 {items, nextCursor}` | `400 validation_failed`, `401`, `404` |
| `POST /shops/:shopId/sync/conflicts/:opId/dismiss` | `products.write` | — | `200 SyncConflict` | `403`, `404`, `409 conflict_not_open`, `429` |

## Push rules (design level)

- Envelope errors fail the request (`400`/`413`); operation errors never do (per-op `rejected`, FR-007). `ops` 1–500; unknown top-level fields refused; operation objects strict (`shopId`, `userId`, `deviceId` in a body → `invalid_op`).
- Operation: `opId` UUIDv7; `hlc` string; `productId` UUID; `stock.adjust {delta ≠ 0, |delta| ≤ 100000, reason}`; `stock.count {counted ≥ 0, base ≥ 0, both ≤ 1000000}`; `product.update {fields: {title? 1..200, description? ≤10000, priceMinor? integer ≥ 0}}`, ≥1 field (limits mirror the catalog's; the catalog stays authoritative → `invalid_field`).
- Result codes (closed): `invalid_op`, `invalid_hlc`, `hlc_node_mismatch`, `clock_implausible`, `op_expired`, `op_id_reused`, `unknown_product`, `product_unavailable`, `invalid_field`, `in_flight`, `contention`, `deadline_exceeded`.
- `replayed: true` returns the original `status`, `quantityAfter`, `productVersion`, `applied/superseded`, `conflict`.
- A 503 uses a generic detail (no SQL, stack, driver text, product content).

## Pull rules

- Entries `{seq, entity: 'product', id, version, deleted, data|null}` in strictly increasing `seq`; limit 1–500 (default 200); no cursor = bootstrap (current state, tombstones within horizon) ending with a cursor from which normal pulls continue.
- Cursor opaque; `invalid_cursor` for malformed/foreign-shop; `resync_required` for old generation, ahead of head, below horizon.

## Removed

Unvalidated numeric cursor, free-form `price`, `duplicate` result, bare list of conflicts, `SyncService` export.

## Rate limit policies (in `catalogSyncRatePolicies`)

`catalog-sync.sync-push.device` 30/min per device+shop; `catalog-sync.sync-pull.device` 120/min per device+shop; `catalog-sync.conflict-write.shop` 60/min per shop — all fail-closed, `429` with `Retry-After`.
