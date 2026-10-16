# HTTP API: S07 bulk import

Prefix `/api`. All bodies/responses are zod schemas in `packages/contracts/src/catalog-sync/imports.ts` (exported from the package index); errors are `application/problem+json` with a stable `code` (S54 filter). Guards: `ShopScoped('products.write' | 'products.read')` (identical `404` for non-members, shop status gate). Path ids are UUIDs (`UuidParamPipe` ⇒ `400 validation_failed`, no query). DTO / query / cursor failures are `400 validation_failed` with `errors:[{field, code}]` (S54; the spec text says 422 — see `gaps.md` Spec changes).

| Method & path | Permission | Request | Success | Notes |
|---|---|---|---|---|
| `POST /shops/:shopId/imports` | write | headers `Idempotency-Key` (8–128 chars, required); body `importStartRequestSchema` `{fileName 1–200 no control chars, sizeBytes int 1…5_368_709_120}` strict | `201 importStartResponseSchema` `{importId, status:'PENDING_UPLOAD', partSize, partCount, parts:[{partNumber,url}], uploadExpiresAt}` | replay = stored body; in-flight `409 idempotency_in_flight`; other body `422 idempotency_key_reuse`; missing/invalid key `422`; `409 too_many_active_imports`; `429 rate_limited` + `Retry-After`; `503` limiter down; `403 shop_suspended`; `409 shop_offboarding` |
| `GET /shops/:shopId/imports/:importId/upload` | write | — | `200 importUploadStateSchema` `{importId, partSize, partCount, uploaded:[{partNumber,etag,sizeBytes}], missing:[{partNumber,url}], uploadExpiresAt}` | `409 import_not_uploadable` unless `PENDING_UPLOAD`; creator-or-writer (write permission) |
| `POST /shops/:shopId/imports/:importId/complete` | write | `importCompleteRequestSchema` `{parts:[{partNumber int ≥1, etag non-empty}]}` | `202` + `Location: /api/shops/:shopId/imports/:importId` + `importJobSchema` (winner) / `200 importJobSchema` (replay) | `422 invalid_parts`, `422 size_mismatch`, `409 import_not_completable` (CANCELLED/EXPIRED), `403/409` shop gate, `503` storage |
| `POST /shops/:shopId/imports/:importId/cancel` | write | — | `200 importJobSchema` | `409 import_not_cancellable` (DONE/FAILED/EXPIRED); repeat on CANCELLED `200`; shop gate applies |
| `GET /shops/:shopId/imports/:importId` | read | — | `200 importJobSchema` | unknown / other shop ⇒ `404 import_not_found` (one body) |
| `GET /shops/:shopId/imports` | read | query `status?` (one of 8), `limit?` int 1–100 (default 20), `cursor?` opaque, tamper-evident | `200 importPageSchema` `{items: importJobSchema-without-history[], nextCursor: string\|null}` | order `createdAt DESC, id DESC`; bad query `400` |
| `GET /shops/:shopId/imports/:importId/error-report` | read | — | `200 importErrorReportSchema` `{url, expiresAt, rows}` | `url` on the user-content origin, 10 min, `attachment; filename="errors-<name>.csv"`, `text/csv; charset=utf-8`; `409 error_report_not_ready` (SCANNING/PROCESSING/UPLOADED/PENDING_UPLOAD), `404 import_error_report_not_found` |

Removed from this domain: `POST /shops/:shopId/exports/orders`, `GET /shops/:shopId/exports/:jobId` (S12).

`importJobSchema`: `{id, shopId, status, fileName, sizeBytes, rowsProcessed, rowsCreated, rowsUpdated, rowsUnchanged, rowsFailed, bytesProcessed, ignoredColumns[], scan:'clean'|'skipped'|null, failure:{code,message}|null, errorReport:{available:boolean, rows:number}, createdBy, createdAt, startedAt|null, finishedAt|null, history:[{status, at}]}`. Never: storage key, upload handle, URL, lease, slot, signature name.

Problem codes (all with `type`/`title`/`status`/`detail`/`instance`/`requestId`): `validation_failed`(400), `idempotency_key_required|invalid|reuse`(422), `idempotency_in_flight`(409), `import_not_found`(404), `invalid_parts`(422), `size_mismatch`(422), `import_not_uploadable`(409), `import_not_completable`(409), `import_not_cancellable`(409), `import_error_report_not_found`(404), `error_report_not_ready`(409), `too_many_active_imports`(409), `rate_limited`(429), `shop_suspended`(403), `shop_offboarding`(409). Registered in the problem catalog (`ProblemCatalogEntry`, owner `domain:catalog-sync`).

Failure codes (`failure.code`): `malware_detected`, `scan_unavailable`, `unsupported_file_type`, `invalid_header`, `malformed_file`, `size_mismatch`, `source_missing`, `too_many_errors`, `shop_not_active`, `internal_error`; `failure.message` is fixed text per code.

Request-body limits: start/complete bodies are small (the platform default 1 MiB suffices; a complete of 80 parts is ~6 KB).
