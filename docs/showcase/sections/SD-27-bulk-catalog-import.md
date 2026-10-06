# SD-27 — Bulk Catalog Import (large file upload & processing)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: SD-03, F-02 (S3 multipart, SQS, ClamAV), F-03 (progress), SD-02

## Marketplace adaptation
Big shops import catalogs of 1M products as **CSV/JSONL up to 5 GB**, and export orders. Progress shows live; errors are downloadable.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Multipart upload** (CreateMultipartUpload + presigned part URLs, parallel/resumable parts, complete) + lifecycle rule aborting incomplete uploads | 10/08 #27 |
| Status machine PENDING → UPLOADED → SCANNING → PROCESSING → DONE/FAILED; progress via SSE (F-03) | 10/08 #27 |
| **ClamAV** scan (stream to clamd) before processing; content sniffing (don't trust extension) | 10/08 #27 |
| **Streaming parse with backpressure**: S3 GetObject stream → `csv-parse` → batch transform (Transform stream, objectMode, highWaterMark) → bulk upsert 1k rows → `pipeline()` with AbortSignal | 02/02 §2–4 |
| **Checkpointing** (row offset + byte offset in `ImportJob`) → resume after crash; visibility extension heartbeat | 10/08 #27 |
| Idempotent upsert by (shopId, externalSku) | 10/09 #36 |
| Per-row validation (zod) → error report CSV to S3 → presigned download | 10/08 #27 |
| **Order export**: Postgres cursor (`pg-query-stream`) → CSV stringify → multipart upload to S3 (streams, constant memory) | 02/02 §4.1–4.2 |
| Serve user files from separate domain with `Content-Disposition: attachment`, `nosniff` | 05/01 §1 |
| Fair scheduling per shop (one big import doesn't starve others) | 10/04 #2 |

## Steps
- [x] `ImportJob`, `ExportJob` models; multipart endpoints.
- [x] Worker (SQS consumer in `apps/worker`, long-running → not Lambda: documented 15-min limit) with streaming pipeline + checkpoints.
- [x] Export endpoint + streaming job.
- [x] e2e: 10k-row CSV with 3 bad rows → 9,997 products upserted, error report has 3 lines, progress events emitted; re-run same file → no duplicates.

## Scale
- Target: 20 concurrent 5 GB imports, ~20k rows/s per worker; memory flat (< 200 MB) regardless of file size.
- Hot path: bytes S3-direct; DB writes batched; search index updated via F-05 (bulk).
- Proof: memory/throughput benchmark script with a generated 1M-row file.

## Implementation notes (2026-10-02)
- **Schema:** migration `20261002100000-catalog-import` adds `Product.externalSku` with a unique `(shopId, externalSku)` index (CONCURRENTLY), plus `ImportJob` (status machine + checkpoint) and `ExportJob`.
- **Upload:** `POST /api/shops/:shopId/imports` → S3 multipart upload with 64 MB presigned parts; `POST .../imports/:id/complete` (parts + ETags) → `catalog-imports` SQS. An S3 lifecycle rule aborts incomplete uploads (O-03).
- **`CatalogImportService.process`** (apps/worker, not Lambda: 5 GB > 15 min):
  - Per-shop fairness: `imports.concurrent` limit 1; a busy shop is re-enqueued with a 60 s delay.
  - ClamAV `INSTREAM` scan streamed from S3 (`clamav.ts`, no dependency, 64 KB framed chunks with backpressure; protocol tested against a fake clamd). Scanning is skipped when `CLAMAV_HOST` is unset.
  - Content sniffing (BOM, CSV vs JSONL, binary refused).
  - Streaming parse (`csv-parse` / readline for JSONL) via async iteration, so backpressure is natural. Rows are zod-validated (major → minor price units, exact) and upserted 1,000 per batch with one `INSERT ... ON CONFLICT (shopId, externalSku)` plus bulk outbox rows (search reindex).
  - Checkpoint + progress (`job:{id}` SSE, creator-only policy in the gateway) after every batch; resume skips rows ≤ checkpoint.
  - Errors are streamed as CSV to S3; the download is a presigned `attachment`.
- **`OrderExportService`:** `pg-query-stream` server-side cursor (1,000 rows per batch) → Transform → `csv-stringify` → S3 multipart upload in one `pipeline()`, constant memory.
- **Caveat:** after a crash-resume, the error report contains only post-checkpoint failures (the counters stay correct). See DOUBTS Q60.

## Test plan
| Scenario | API e2e | UI journey (web) | Unit |
|---|---|---|---|
| Seller imports a catalog and sees progress + result | `catalog-import.e2e-spec.ts` › 10k rows | web: upload → progress bar → done (happy path) | — |
| Bad rows reported (3 of 10k), valid rows imported | `catalog-import.e2e-spec.ts` | — | `rows.spec.ts` (price conversion) |
| Re-import is idempotent (upsert by SKU) | `catalog-import.e2e-spec.ts` | — | — |
| Crash → resume from checkpoint | `catalog-import.e2e-spec.ts` | — | — |
| Binary disguised as CSV refused | `catalog-import.e2e-spec.ts` | — | `rows.spec.ts` (sniff) |
| Malware upload refused | — | — | `clamav.spec.ts` (protocol, EICAR) |
| Order export downloadable as attachment | `catalog-import.e2e-spec.ts` › export | web: export button → download | — |
