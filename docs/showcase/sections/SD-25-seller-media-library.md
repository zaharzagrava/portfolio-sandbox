# SD-25 — Seller Asset Library & Digital Product Delivery (Dropbox-style)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: F-02 (S3), SD-02, SD-19 (purchases)

## Marketplace adaptation
Shops keep an **asset library** (product photos, manuals, marketing kits) synced across team devices, and sell **digital products** (e-books, software, 3D models up to 50 GB) delivered to buyers after purchase.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Content-defined chunking** (FastCDC, ~4 MB avg) client-side; chunks stored by SHA-256 `chunks/{hash}`; file version = ordered chunk list | 10/08 #25 |
| Upload: client asks which hashes are missing → presigned PUT only for those → commit version in one tx (**dedupe + delta sync**) | 10/08 #25 |
| Dedupe scoped per shop (privacy: cross-tenant dedupe leaks existence) | 10/08 #25 |
| **Change journal** per shop (seq cursor) → devices pull changes; long-poll/SSE notification | 10/08 #25 |
| Conflicts → "conflicted copy" versions | 10/08 #25 |
| ACLs inherited from folders; **share links** (token, expiry); downloads via short-lived signed URLs | 10/08 #25 |
| **Reference-counted GC** of unreferenced chunks (async, grace period) | 10/08 #25 |
| Digital delivery: purchase entitlement → signed, per-buyer, expiring download URL; watermark hook | — |

## Steps
- [x] Models: `AssetFolder`, `Asset`, `AssetVersion`, `Chunk(hash, size, refCount)`, `AssetVersionChunk`, `AssetChange`.
- [x] Endpoints: missing-chunks check, presign chunks, commit version, list changes since cursor, share links, digital download.
- [x] GC job; FastCDC reference implementation for tests/CLI (`scripts/asset-sync-cli.ts`).
- [x] e2e: upload file, modify middle → second version uploads only changed chunks; delete version → GC frees unique chunks only.

## Scale
- Target: 50M shops' assets, 10 PB; metadata ops 20k RPS.
- Hot path: bytes S3-direct; metadata Postgres partitioned by shopId hash (or Dynamo for chunk refs at PB scale — documented).

## Implementation notes (2026-10-02)
- **`fastcdc.ts`** (FastCDC with normalized chunking, fixed gear table): checked locally — 1 MB random file, 8 KB target → 105 chunks, mean ≈ 10 KB, all within bounds; a 14-byte insertion mid-file changes **1** chunk. Production sizes are 1 / 4 / 16 MB. Unit spec.
- **Migration `20261002110000-asset-library`:** `Asset` (path, current version), `AssetVersion` (ordered chunk list), `AssetChunk` (per-shop dedupe, refCount, `unreferencedSince`), `AssetChange` (per-shop seq journal), `AssetShareLink` (hashed token, expiry, cap), `DigitalProduct`.
- **Storage port gained `presignPutChecked`:** the presigned PUT signs `x-amz-checksum-sha256` + length, so S3 rejects bytes that don't match the hash (content-addressed integrity without a server read).
- **`AssetsService`:**
  - `prepareUpload` returns URLs only for missing chunks (delta sync), with placeholder rows that start the GC grace period.
  - `commit` locks chunks (`FOR UPDATE`), HEAD-checks new ones, verifies the size; a stale `baseVersion` becomes a **conflicted copy**; then refcounts + journal.
  - `deleteVersion` releases refs.
  - `gc` (worker, hourly) deletes chunks unreferenced > 24 h via `DELETE ... FOR UPDATE SKIP LOCKED` + S3 delete.
  - `manifest` gives parallel chunk URLs for clients; `stream` reassembles in order with backpressure.
  - Share links: hashed token; atomic cap/expiry in the UPDATE.
  - Digital products: a paid order line is the entitlement → 10-minute buyer-bound JWT → attachment stream with `X-Licensed-To` (watermarking hook).
- **Dedupe is per shop:** cross-tenant dedupe would leak "this file exists".

## Test plan
| Scenario | API e2e | UI journey (web / mobile) | Unit |
|---|---|---|---|
| Upload a file, edit it, re-sync uploads only changed chunks | `assets.e2e-spec.ts` | desktop/web sync client: save → synced (happy path) | `fastcdc.spec.ts` (locality) |
| Concurrent edits → conflicted copy | `assets.e2e-spec.ts` | — | — |
| Version delete + GC frees only unique chunks | `assets.e2e-spec.ts` | — | — |
| Share link download cap | `assets.e2e-spec.ts` | web: open share link → download | — |
| Buyer downloads a purchased digital product; non-buyer refused; expired token refused | `assets.e2e-spec.ts` | web + mobile: "My purchases" → download | — |
