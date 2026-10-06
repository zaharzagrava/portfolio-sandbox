# SD-10 — Product & Review Photos (Instagram-style media pipeline)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: SD-03, F-02 (S3, SQS), SD-11 (posts with photos), SD-09 (feed)

## Marketplace adaptation
Shops upload product galleries; buyers attach photos to reviews and discussion posts ("unboxing pics"). Photos appear in feeds once processed.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Presigned POST** with policy (content-type, max size) — bytes never touch API servers; server-generated keys `shops/{shopId}/media/{uuid}` | 10/05 #10, 10/08 #27 |
| S3 event → SQS → **thumbnail Lambda** (sharp): validate magic bytes, **strip EXIF/GPS**, resize (thumb/feed/full), WebP/AVIF, content-hashed immutable keys | 10/05 #10 |
| Media record `PROCESSING → READY / REJECTED`; post becomes visible when ready (outbox event → feed fan-out) | 10/05 #10 |
| Idempotent processing (same input key → same outputs; Dynamo idempotency) | 10/04 #3 |
| CDN delivery with `immutable` cache; private media via **CloudFront signed URLs** (existing signer) | 10/05 #10 |
| Storage tiers: originals → S3 IA/Glacier lifecycle after 30 days | 10/05 #10 |
| Perceptual hash (dHash) to detect duplicate/stolen product photos across shops | — |

## Steps
- [x] `Media` model (Postgres; shop/user scoped), `POST /media/uploads` (presigned POST), `GET /media/:id`.
- [x] Lambda `image-processor` (sharp) + local runner wiring.
- [x] Ready event → attach to product/post.
- [x] e2e: upload request → presigned policy limits; simulated S3 event → derivatives exist in MinIO, EXIF stripped, status READY.

## Scale
- Target: 600 uploads/s peak, 100k image views/s (CDN).
- Hot path: API only signs (no bytes); processing elastic via Lambda; delivery CDN.
- Proof: k6 presign endpoint; pipeline throughput script with 1k images.

## Implementation notes (2026-10-02)
- **Schema:** migration `20261002090000-media` adds `Media` (status machine, variants JSON, dHash + 4 indexed 16-bit bands) and `ProductMedia` (gallery order).
- **`image-pipeline.ts`** (pure, real libvips), checked locally against real sharp:
  - Format sniffed from the bytes (declared type ignored) and checked against an allowlist.
  - `limitInputPixels` 50 MP: a 285 KB PNG declaring 100 MP is rejected.
  - EXIF orientation applied, then all metadata (GPS) dropped.
  - thumb/feed/full WebP widths, never upscaled; content-hashed outputs, so keys are deterministic and immutable.
  - dHash: a re-encoded half-size copy lands 1 bit away, an unrelated image 30 bits away.
- **`MediaProcessor`** (framework-free core of the Lambda): claim → process → put variants (`Cache-Control: immutable`) → near-duplicate search (band candidates, then exact Hamming ≤ 3, other shops only) → READY + `media.ready` outbox row in one transaction. Rejected uploads become REJECTED; a duplicate S3 event is SKIPPED.
- **`MediaService` (core):**
  - Presigned POST with a server-chosen key; the policy enforces `image/*` and ≤ 15 MB.
  - `complete` HEAD-checks the object, then enqueues; in AWS the bucket's ObjectCreated → SQS notification makes this optional.
  - `get` returns CDN URLs (`MEDIA_CDN_URL`).
  - Gallery attach accepts only READY media of the same shop.
- **Endpoints:** `POST /api/media/uploads` (buyers), `POST /api/shops/:shopId/media/uploads`, `POST /api/media/:id/complete`, `GET /api/media/:id`, `PUT /api/shops/:shopId/products/:productId/gallery`.
- **Lambda** `media-processing` accepts native S3 event notifications and `{originalKey}` messages; Dynamo idempotency per key.
- **Lifecycle** (Terraform, O-03): `media/originals/*` move to S3 IA after 30 days and Glacier after 180; derived objects are served via CloudFront.

## Test plan
| Scenario | API e2e | UI journey (web / mobile) | Unit |
|---|---|---|---|
| Seller uploads a product photo and it appears in the gallery | `media.e2e-spec.ts` › processing → READY | web + mobile: upload happy path only | — |
| Presign contract (server key, image/*, 15 MB in the signed policy) | `media.e2e-spec.ts` › presigned POST | — | — |
| Non-image / disguised file → REJECTED | `media.e2e-spec.ts` | — | `image-pipeline.spec.ts` (PDF) |
| Decompression bomb rejected | — | — | `image-pipeline.spec.ts` |
| EXIF/GPS stripped, no upscaling, deterministic keys | `media.e2e-spec.ts` (stored object) | — | `image-pipeline.spec.ts` |
| Duplicate S3 event → SKIPPED | `media.e2e-spec.ts` | — | — |
| Re-saved copy from another shop flagged | `media.e2e-spec.ts` | — | `image-pipeline.spec.ts` (dHash distance) |
