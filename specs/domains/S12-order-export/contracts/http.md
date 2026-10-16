# HTTP contract: order exports

Base `/api`. Schemas live in `packages/contracts/src/orders/order-export.ts` and are exported from the package index. Errors are `application/problem+json` with `type, title, status, detail, instance, requestId, code`; 5xx `detail` is generic. Full scenario detail: [spec.md](../spec.md) §Provides.

| Method & path | Permission / guards | Success | Errors (`code`) |
|---|---|---|---|
| `POST /shops/:shopId/order-exports` | `ShopScoped('orders.manage')`, `@Idempotent` (key 8–128 `[A-Za-z0-9_-]`, 24 h), `@RateLimit('orders.export-start.shop')` 5/h/shop fail-closed; body strict `{}` | `202`, `Location: /api/shops/:shopId/order-exports/:exportId`, `orderExportSchema`; replay adds `Idempotency-Replayed: true` | 400 `validation_failed`; 401; 403 `permission_denied`/`shop_suspended`; 404 `shop_not_found`; 409 `shop_offboarding`/`idempotency_in_flight` (+`Retry-After: 1`)/`export_already_active` (+`activeExportId`); 422 `idempotency_key_required`/`_invalid`/`_reuse`; 429 `rate_limited` (+`Retry-After`) |
| `GET /shops/:shopId/order-exports?status&limit&cursor` | `ShopScoped('orders.manage')` | `200 orderExportPageSchema` `{items, nextCursor}`; `limit` 1–100 default 20; order `createdAt` desc, `id` desc; `status` one of the six | 400 `validation_failed`, `invalid_cursor`; shop gate codes |
| `GET /shops/:shopId/order-exports/:exportId` | same | `200 orderExportSchema` | 400; 404 `export_not_found` (also for another shop's export) |
| `POST /shops/:shopId/order-exports/:exportId/cancel` | same | `200 orderExportSchema` (`CANCELLED`; repeat is `200` unchanged) | 404 `export_not_found`; 409 `export_not_cancellable` (`DONE`/`FAILED`/`EXPIRED`) |
| `GET /shops/:shopId/order-exports/:exportId/download` | same | `200 orderExportDownloadSchema` `{url, expiresAt}` (10 min, attachment `orders-<exportId>.csv`, `text/csv`, user-content origin) | 404 `export_not_found`; 409 `export_not_ready`; 410 `export_expired` |

**Removed**: `POST /shops/:shopId/exports/orders`, `GET /shops/:shopId/exports/:jobId` answer `404` with no alias.

## `orderExportSchema`

```
{ exportId: uuid, status: 'QUEUED'|'RUNNING'|'DONE'|'FAILED'|'CANCELLED'|'EXPIRED',
  rowsWritten: int>=0, totalRows: int>=0|null, bytesWritten: int>=0, attempt: int>=0,
  failure: { code: ExportFailureCode, message: string } | null,
  createdBy: uuid, createdAt: iso, startedAt: iso|null, finishedAt: iso|null, expiresAt: iso|null }
```
Strict object: never `fileKey`, `shopId`, lease, history or idempotency data. `ExportFailureCode` = `storage_unavailable | catalog_unavailable | database_unavailable | row_limit_exceeded | timeout | shop_not_found | attempts_exhausted | internal_error`; each code has one fixed generic message in `domain/export-failure.ts` (e.g. `storage_unavailable` → "The file could not be stored. Start a new export.").

Other schemas: `orderExportCreateRequestSchema` = `z.strictObject({})`; `orderExportPageSchema` = `{items: orderExportSchema[], nextCursor: string|null}`; `orderExportDownloadSchema` = `{url: url, expiresAt: iso}`; `orderExportProgressEventSchema` and `orderExportEventSchemas` in [async.md](async.md).

## Controller rules
One service call per method (II.1); params validated with a uuid pipe (`400 validation_failed`); the shop in the path is part of every repository predicate; the download writes the `order_export_downloaded` log line `{exportId, shopId, userId}` (no link).
