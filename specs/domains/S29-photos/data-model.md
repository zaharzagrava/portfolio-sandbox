# Data model: S29 photos (domain `media`)

Owner of every table below: `domain:media` (`packages/backend/db/ownership.ts`). `ProductMedia` moves from `domain:catalog` to `domain:media`; `MediaStatusHistory` and `ProductGallery` are added. No foreign key leaves these tables (the one internal FK `ProductMedia.mediaId → Media.id` stays, without cascade). Video tables (`Video`, `VideoTask`) are S30's and unchanged. Migration steps: `research.md` R-12.

## `Media`

| Column | Type | Rules |
|---|---|---|
| `id` | UUID PK | `uuidv7()` default (time-ordered: tie-break "earliest" = smallest id) |
| `shopId` | UUID NULL | set for `product`, null for `review`; no FK after contract |
| `uploaderId` | UUID NOT NULL | no FK after contract; never in public views |
| `purpose` | TEXT | CHECK `product` \| `review` (`post` removed; legacy rows become `DELETED`) |
| `status` | TEXT | CHECK `PENDING_UPLOAD`, `UPLOADED`, `PROCESSING`, `READY`, `REJECTED`, `EXPIRED`, `DELETED` |
| `originalKey` | TEXT UNIQUE | `media/originals/shops/<shopId>/<uuid>` or `media/originals/users/<userId>/<uuid>`; never leaves the service |
| `variants` | JSONB NULL | `{thumb,feed,full:{key,width,height}}`, keys `media/derived/<sha256>.webp`; set only with `READY` |
| `width`, `height` | INT NULL | oriented source size, set with `READY` |
| `dhash` | TEXT NULL | 64-bit hex; **product photos only**; never exposed |
| `dhashB0..B3` | INT NULL | four 16-bit bands of `dhash` |
| `possibleDuplicateOf` | UUID NULL | private; set only at the READY transition |
| `duplicateDistance` | SMALLINT NULL (new) | 0..3 |
| `duplicateAt` | TIMESTAMPTZ NULL (new) | |
| `rejectCode` | TEXT NULL (new, replaces `rejectReason`) | closed vocabulary: `not_an_image`, `format_not_allowed`, `multi_frame`, `image_too_large`, `size_invalid`, `malware_detected`, `processing_failed`; set only with `REJECTED` |
| `attempts` | INT NOT NULL DEFAULT 0 (new) | +1 on every claim; > 5 → reject `processing_failed` |
| `leaseUntil` | TIMESTAMPTZ NULL (new) | set by claim (`now + 5 min`), cleared on READY/REJECTED/release |
| `uploadedAt` | TIMESTAMPTZ NULL (new) | set at `→ UPLOADED`; the re-drive job's age |
| `version` | INT NOT NULL DEFAULT 1 (new) | +1 on every transition; published as `mediaVersion` |
| `createdAt`, `updatedAt` | TIMESTAMPTZ | |

**Indexes**: `originalKey` (unique); `(uploaderId, status)` (pending quota, owner lookups); `(shopId)`; `(uploadedAt) WHERE status='UPLOADED'`; `(leaseUntil) WHERE status='PROCESSING'`; `(createdAt) WHERE status='PENDING_UPLOAD'` (exists); `(updatedAt) WHERE status IN ('REJECTED','EXPIRED','DELETED')` (purge); four band indexes `WHERE status='READY' AND purpose='product'`.

**Invariants** (checked by the repository's conditional updates, not in the service): `READY` ⇒ `variants`, `width`, `height` not null; `REJECTED` ⇒ `rejectCode` not null; a duplicate match only on `READY` product photos; `DELETED` final.

## State machine (`domain/media-status.ts`, AS-49)

```
PENDING_UPLOAD → UPLOADED | PROCESSING | REJECTED | EXPIRED | DELETED
UPLOADED       → PROCESSING
PROCESSING     → READY | REJECTED | PROCESSING (lease takeover, attempts+1)
READY | REJECTED | EXPIRED → DELETED
DELETED        → (final)
```

Every transition = one conditional `UPDATE … WHERE id=$ AND status=$from` that must return one row, plus one `MediaStatusHistory` row and a `version` bump in the same transaction; events (`media.ready`, `media.rejected`, `media.deleted`) are appended in that transaction.

## `MediaStatusHistory`

| Column | Type | Rules |
|---|---|---|
| `id` | UUID PK `uuidv7()` | |
| `mediaId` | UUID NOT NULL | same owner; index `(mediaId, createdAt)` |
| `fromStatus` | TEXT NULL | null for creation |
| `toStatus` | TEXT NOT NULL | same CHECK as `Media.status` |
| `actorType` | TEXT | `user` \| `system` \| `worker` |
| `actorId` | UUID NULL | the user for `user` |
| `rejectCode` | TEXT NULL | for `→ REJECTED` |
| `createdAt` | TIMESTAMPTZ | from the clock |

Append-only; removed only with its photo by the purge job.

## `ProductMedia` (moved to media)

`productId UUID NOT NULL` (no FK), `mediaId UUID NOT NULL → Media(id)`, `position SMALLINT NOT NULL`; PK `(productId, mediaId)`; new `UNIQUE (productId, position)` (deferrable initially deferred, so the replace can insert in order); index `(mediaId)` for the `media_in_use` check.

## `ProductGallery` (new)

`productId UUID PK`, `shopId UUID NOT NULL`, `version INT NOT NULL DEFAULT 0`, `updatedAt TIMESTAMPTZ`; index `(shopId)`. Version row created on first write (`INSERT … ON CONFLICT DO NOTHING`), locked `FOR UPDATE` by each replace. Removed by `catalog.product_deleted` and `tenancy.shop_deleted`.

## Object storage

| Prefix | Content | Access |
|---|---|---|
| `media/originals/…` | uploaded bytes | private; written by the browser with the signed permission; read only by the worker; deleted on malware, size rejection, expiry and purge |
| `media/derived/<sha256>.webp` | variants | public through the media origin; `image/webp`; `Cache-Control: public, max-age=31536000, immutable`; deleted by purge only when no live photo references the key |

## Queue

`media-processing` (standard queue) carries `{mediaId?, originalKey}` or an S3 native notification. Message attributes `requestId`, `traceId` copied from the request context. Defined in `elasticmq.conf` with its DLQ (L-002; checked at implementation).

## Pure domain modules (no framework, no clock)

| File | Content |
|---|---|
| `domain/media-status.ts` | statuses, transitions, `assertTransition`, `assertNever` |
| `domain/reject-code.ts` | the closed vocabulary and `RejectedImageError` code type |
| `domain/duplicate-match.ts` | `bands`, `hamming`, `isNearUniform`, `findNearest`, `NEAR_DUPLICATE_BITS`, `CANDIDATE_CAP` |
| `domain/upload-policy.ts` | allowed content types, limits (15 MiB, 50 MP, 20 gallery photos, 50 pending, 600 s, 60 min, 7 d), key builder |
| `domain/ports.ts` | `MediaRepository`, `GalleryRepository`, `Blobs`, `MalwareScanner` (re-declared token), `MediaMetrics`, `MediaLogger`, `SqlRunner`, `Tx` |
| `domain/media-urls.ts` | `toUrls(variants, origin)` |
