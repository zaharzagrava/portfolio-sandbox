# Feature Specification: S29 — Product and Review Photos: Presigned Upload, Processing Pipeline, EXIF Strip, Variants, Duplicate Detection (domain `media`)

**Feature Branch**: `S29-photos` (spec directory `specs/domains/S29-photos`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S29 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-10-review-photos.md`, `10-System-Design/05-social-and-content.md` (design 10), `10-System-Design/08-media-and-files.md` (design 27). Pattern-map row covered: **P0509** (upload security: separate domain, nosniff, attachment, AV scan, magic bytes), shared with S07.

## Scope

A **photo** is an image a person puts on the marketplace: a seller's product picture or a buyer's review picture. This capability owns the whole life of that image: how it gets into the system without the API ever seeing its bytes, how it is checked and made safe, the sizes it is served in, whether it looks stolen from another shop, who can see it, and how it is attached to a product gallery.

In scope:

- Upload requests for product photos (a shop member) and review photos (a signed-in buyer): a server-generated storage location, a signed upload permission with hard limits, quotas and rate limits.
- The upload-complete confirmation and the alternative path where storage itself announces the new object.
- The processing pipeline: format decided from the bytes, size and pixel limits, malware scan, orientation applied and all metadata (location, camera, owner) removed, three WebP sizes, content-addressed immutable outputs, an idempotent, lease-protected, bounded-retry worker.
- The photo's status machine (`PENDING_UPLOAD → UPLOADED → PROCESSING → READY | REJECTED`, plus `EXPIRED` and `DELETED`) with a history row for every transition.
- Near-duplicate detection of product photos across shops, as a private trust-and-safety signal.
- Who can read a photo and in which state; the batch read the BFF composes (IX.7 R2) and the exported lookup other domains use (IX.7 R1).
- The ordered product gallery (`ProductMedia`): replace, reorder, clear, optimistic concurrency, public and member reads.
- Deleting a photo, expiring unused upload slots, re-driving lost work, purging rejected or deleted files, and reacting to product and shop deletion.
- The events other domains consume (`media.ready`, `media.rejected`, `media.deleted`, `media.gallery_changed`, `media.duplicate_suspected`).
- Delivery rules: derived images only, from a separate media origin, immutable, `nosniff`; originals are never served.

Out of scope (owned elsewhere):

- Video upload, transcoding, HLS and signed video delivery → **S30** (also `media`; `VideoModule` is not touched here).
- The product record, its status and its public visibility rules → **S05**. This capability asks S05 (R1) whether a product exists in a shop and is active.
- Shop membership, roles, permissions and shop status → **S03**.
- Reviews themselves (no capability exists yet: `rating` has no writer, S05), discussion post bodies (**S25**: posts are text only in this release), feed rendering and fan-out (**S26**), brand-story images (**S27**: not offered), catalog sync of provider images (**S08**: images are not synced). They reference a photo by its ID and read it through the exports below.
- The outbox, consumers and projections framework → **S53**. Rate-limit engine → **S50**. Job scheduler → **S49**. Error filter, request context, metrics, config validation → **S54**. Web screens → **W04** (seller gallery). Journeys → **J02**.
- A moderation console for duplicate suspicions: this capability only produces the signal (`media.duplicate_suspected`); a human workflow is not part of this release.
- Face or content moderation, AVIF output, CDN configuration itself (its headers are proven by an ops artifact, AS-60).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A seller uploads a product photo and it appears in the gallery (Priority: P1)

A seller asks for permission to upload, sends the file straight to storage, confirms it, waits a few seconds, and then puts the finished photo first in the product's gallery. Nobody else can use, see, complete or delete the seller's half-finished uploads, and the platform never receives the file's bytes.

**Why this priority**: no photo, no product page worth buying from. Every other story depends on this flow.

**Independent Test**: with two shops and users of each role, request an upload, put real bytes in storage with the permission that was issued, complete, run the worker, read the photo, then set the gallery; replay and cross-shop attempts at every step.

**Acceptance Scenarios**:

1. **AS-01** (presign, product) — **Given** a `STAFF` member of an `ACTIVE` shop `S` and the clock frozen at `T`, **When** `POST /shops/S/media/uploads {purpose:"product"}`, **Then** `201` with `{mediaId, upload:{url, fields, expiresAt}, maxBytes:15728640, allowedContentTypes:["image/jpeg","image/png","image/webp","image/avif"]}` parsed by `mediaUploadResponseSchema`; `expiresAt = T + 600 s`; one `Media` row exists with `status: "PENDING_UPLOAD"`, `purpose: "product"`, `shopId: S`, `uploaderId` = the caller, and a **server-generated** storage key of the form `media/originals/shops/S/<uuid>` that is not in the request; one history row (`null → PENDING_UPLOAD`, actor, time); the signed permission names exactly that key, allows only the listed content types, and allows a body of 1 to 15,728,640 bytes; the response never contains the key of any other object; no image byte crossed the API (the request body was ≤ 4 KiB).
2. **AS-02** (presign, review) — **Given** a signed-in buyer `U`, **When** `POST /media/uploads {purpose:"review"}`, **Then** `201` as AS-01 with `shopId: null` and a key `media/originals/users/U/<uuid>`; **When** the body carries `purpose: "product"`, `"post"`, any other value, or no purpose, **Then** `400 validation_failed` and nothing is persisted (`post` is no longer offered, `questions.md`).
3. **AS-03** (presign, validation and authorization) — **Given** the two presign routes, **When** the body contains any field besides `purpose` (a `key`, `shopId`, `mediaId`, `contentType`, `maxBytes`) or `purpose` has the wrong type; **Then** `400 validation_failed` naming the field. **When** called without credentials, **Then** `401`. **Given** a `VIEWER` member, **Then** `403 permission_denied` on the shop route; **Given** a user who is not a member of `S`, or an unknown `S`, **Then** the same `404` body for both. **Given** `S` is `SUSPENDED`, **Then** `403 shop_suspended`; `DELETING`, **Then** `409 shop_offboarding` (S03 gate). In every case nothing is persisted.
4. **AS-04** (pending-upload quota) — **Given** an uploader who already holds 50 rows in `PENDING_UPLOAD`, **When** they request another upload on either route, **Then** `409 pending_uploads_limit` with the current count, and no row is created; **Given** one of the 50 is completed, expired or deleted, **When** they ask again, **Then** `201`. The count is per uploader and per purpose scope (a shop's product uploads do not count against the same person's review uploads).
5. **AS-05** (rate limits) — **Given** the policies `media.upload.user` (30 per minute per user, fail closed) and `media.upload.shop` (120 per minute per shop, fail closed), **When** a user sends a 31st review-upload request within a minute, or a shop receives a 121st product-upload request, **Then** `429` with `Retry-After` and no row is created; reads are unaffected; **Given** the limiter's store is down, **Then** `503` problem+json with a generic detail (fail closed).
6. **AS-06** (storage enforces the signed permission) — **Given** a permission issued by AS-01 and a real object store, **When** the browser step is replayed with (a) a valid JPEG, **Then** the object is stored at the key; (b) a content type outside the list, (c) a body of 15,728,641 bytes, (d) a different key, **Then** the store refuses each (`403`/`400` from storage) and no object appears; the platform's API was not called in any of these steps.
7. **AS-07** (complete) — **Given** a `PENDING_UPLOAD` photo whose object is present, **When** its uploader calls `POST /media/:id/complete`, **Then** `202 {status:"UPLOADED"}`; the row moved `PENDING_UPLOAD → UPLOADED` with a history row, and **after the commit** exactly one message `{mediaId, originalKey}` was put on the processing queue (never inside the transaction).
8. **AS-08** (complete before the bytes, or with a bad object) — **Given** a `PENDING_UPLOAD` photo whose object is missing, **When** its uploader completes, **Then** `409 upload_incomplete`, the status is unchanged and no message is sent; after the browser step succeeds, completing works. **Given** the object exists but is larger than 15,728,640 bytes (the store's limit was bypassed) or has size 0, **Then** the photo becomes `REJECTED` with code `size_invalid`, the object is deleted, and the response is `200 {status:"REJECTED", rejectCode:"size_invalid"}`.
9. **AS-09** (complete replay and concurrency) — **Given** a `PENDING_UPLOAD` photo with its object, **When** two `complete` requests arrive at the same moment, **Then** both answer `202` with the same photo, exactly one transition `PENDING_UPLOAD → UPLOADED` and exactly one queue message exist. **Given** the photo is `UPLOADED` or `PROCESSING`, **When** `complete` is called again, **Then** `202` with the current status and no new message. **Given** `READY` or `REJECTED`, **Then** `200` with the status (and `rejectCode` when rejected) and no message.
10. **AS-10** (complete on terminal states) — **Given** a photo `EXPIRED`, **When** `complete` is called, **Then** `409 upload_expired`; **Given** `DELETED` or an unknown ID, **Then** `404 media_not_found` (identical body); a non-UUID ID, **Then** `400`. Without credentials, **Then** `401`.
11. **AS-11** (storage-notification path, out-of-order complete) — **Given** a `PENDING_UPLOAD` photo, **When** the storage's own "object created" notification for its key reaches the worker and the client never calls `complete`, **Then** the photo is processed to `READY` (the claim accepts `PENDING_UPLOAD` and `UPLOADED`); **When** the client's `complete` arrives afterwards, **Then** it answers per AS-09 (`200 READY`) with no second message. A notification for a key outside `media/originals/` is ignored (no row read, no effect).

---

### User Story 2 — Every photo is made safe before anyone can see it (Priority: P1)

An upload is untrusted bytes. The platform decides what it really is, refuses what is not an acceptable image, scans it, removes the buyer's home coordinates and everything else hidden in it, and produces three small, fast, permanent versions. Only then does it become visible.

**Why this priority**: a stored XSS, a malware drop or a leaked home address from a review photo is a security incident, not a bug.

**Independent Test**: put each kind of input (good photo with GPS, disguised files, decompression bomb, infected file, valid file declared with the wrong type) at an upload key and run the worker against the real database and object store; assert the status, the stored objects and the events.

**Acceptance Scenarios**:

1. **AS-12** (happy path) — **Given** an `UPLOADED` photo whose object is a 1800×1200 JPEG carrying GPS coordinates, camera make and an orientation tag, **When** the worker processes its key, **Then** the result is `READY`; `variants` has `thumb` (200 px wide), `feed` (640) and `full` (1600), each `image/webp`, aspect ratio of the oriented source kept (heights within 1 px of the ratio), stored under `media/derived/<content-hash>.webp` with `Cache-Control: public, max-age=31536000, immutable`; `width`/`height` of the row are those of the oriented source; the stored variant objects contain no location, camera, owner or colour-profile metadata; the original object is unchanged and stays private; in **one** transaction the row became `READY` (history `PROCESSING → READY`) and one outbox row `media.ready` was written; the owner then sees `urls` for all three variants.
2. **AS-13** (metadata and orientation, pure) — **Given** a JPEG with orientation tag 6, GPS, XMP, IPTC and an ICC profile other than sRGB, **When** processed, **Then** every variant is upright (a 1200×1800 stored image yields a portrait result), carries no EXIF, GPS, XMP, IPTC or ICC data, and its pixels are in sRGB (the dominant colour of a saturated Display-P3 patch stays within a tolerance of the sRGB conversion).
3. **AS-14** (never upscaled, pure) — **Given** a 300×200 source, **When** processed, **Then** `thumb` is 200 px wide and `feed` and `full` are 300 px wide (never larger than the source); all three names are present.
4. **AS-15** (deterministic, pure) — **Given** the same input bytes processed twice (also concurrently), **Then** every variant has the same bytes and therefore the same key; storing it twice leaves one object per key.
5. **AS-16** (rejection classes, pure) — **Given** the inputs: a PDF; a PHP script; a text file; a zero-byte file; a truncated JPEG; an SVG with a script; a GIF; an animated WebP; a TIFF; a PNG that declares 100 megapixels in 300 KB (a decompression bomb); **When** each is inspected, **Then** each is refused with exactly one stable code: `not_an_image` (PDF, PHP, text, zero-byte, truncated), `format_not_allowed` (SVG, GIF, TIFF), `multi_frame` (animated WebP), `image_too_large` (more than 50,000,000 pixels, decided from the header before the pixels are decoded). The codes are the whole vocabulary: `not_an_image`, `format_not_allowed`, `multi_frame`, `image_too_large`, `size_invalid`, `malware_detected`, `processing_failed`. No decoder message ever becomes a code.
6. **AS-17** (rejection end to end; the declared type is ignored) — **Given** an `UPLOADED` photo whose object is a PHP script that was uploaded with the declared type `image/jpeg`, **When** the worker runs, **Then** the photo is `REJECTED` with `rejectCode: "not_an_image"` (history `PROCESSING → REJECTED`), no variant object was written, one outbox row `media.rejected` exists and no `media.ready`; the owner's `GET` shows `status: "REJECTED"` and the code. **Given** a genuine PNG uploaded with the declared type `image/jpeg`, **Then** it becomes `READY` (the bytes decide, not the label).
7. **AS-18** (malware) — **Given** a valid-looking image that the malware scanner (a system-edge fake) reports as infected, **When** processed, **Then** `REJECTED` with `malware_detected`, no variant written, **the original object is deleted at once**, and `media.rejected` carries the same code. In production the scan is mandatory: a photo never becomes `READY` unscanned.
8. **AS-19** (scanner unavailable) — **Given** the scanner times out or is unreachable, **When** the worker processes a photo, **Then** it ends the run with a transient failure (the queue message is not acknowledged, the next delivery retries), the status is `PROCESSING` with the attempt counted, no variant is written, no event is written, and the photo is never `READY`; when the scanner returns, the retry completes normally.
9. **AS-20** (duplicate delivery) — **Given** a `READY` photo, **When** the same key is delivered again (sequentially, any number of times), **Then** the worker answers `SKIPPED`, writes no object, no row and no outbox row; the same for `REJECTED`, `EXPIRED` and `DELETED`; an unknown key answers `SKIPPED` and increments an unknown-key counter.
10. **AS-21** (concurrent delivery and lease takeover) — **Given** one `UPLOADED` photo, **When** two workers receive its key at the same moment, **Then** exactly one claims it and processes; the other answers `BUSY` (its message is retried later, then `SKIPPED`); exactly one `media.ready` row exists. **Given** a worker that claimed the photo and died, **When** the lease (5 minutes) has not expired, **Then** another worker answers `BUSY`; **When** the clock passes the lease, **Then** it claims the photo again (attempt 2) and completes it.
11. **AS-22** (poison input, attempt cap) — **Given** a photo whose processing fails with a transient error on every attempt, **When** the fifth claim is attempted, **Then** instead of processing, the photo becomes `REJECTED` with `processing_failed`, `media.rejected` is written, and the message is acknowledged (no infinite loop); a metric and an error log with the media ID record it.
12. **AS-23** (timeouts) — **Given** the object store hangs on the read of the original, **When** the worker runs, **Then** the read is cut after 20 s, the run ends as a transient failure (attempt counted, status `PROCESSING`, lease released), and a single image's total processing never exceeds 45 s (a slower image ends the run the same way).
13. **AS-24** (partial variant write) — **Given** the store accepts the first two variant writes and refuses the third, **When** the worker runs, **Then** the photo is not `READY`, no event is written, and the run ends as a transient failure; on the retry all three variants are written (the first two under the same keys, no extra objects) and the photo becomes `READY` only after a check that all three objects exist.

---

### User Story 3 — A stolen product photo is noticed (Priority: P2)

When a shop uploads a product photo that is a re-saved, resized or recompressed copy of another shop's photo, the platform notices, without blocking the honest majority and without telling the thief or the victim who matched.

**Why this priority**: marketplace trust; but a false positive must never stop a seller from selling, so it is advisory.

**Independent Test**: process a photo for shop A, then a recompressed half-size copy for shop B, and an unrelated image; read the rows, the API views and the events.

**Acceptance Scenarios**:

1. **AS-25** (flagged across shops) — **Given** a `READY` product photo of shop `A` and a 900-px, quality-55 re-save of it uploaded by shop `B`, **When** `B`'s photo is processed, **Then** it still becomes `READY` and usable; its row records `possibleDuplicateOf = A's photo`, the distance (≤ 3 of 64 bits) and the time; `media.ready` carries `duplicateSuspected: true` and **no** identifier of the matched photo; one outbox row `media.duplicate_suspected {mediaId, shopId, matchedMediaId, matchedShopId, distance}` was written in the same transaction; no API response (owner view, public view, batch, gallery) contains the match, its owner or its distance; the counter `media_duplicate_suspected_total` increased by one.
2. **AS-26** (not flagged) — **Given** each of: a re-upload by the same shop; an unrelated image (distance > 3); a `review` photo that matches a product photo; a product photo that matches only a `review` photo; a match only against photos that are `REJECTED`, `DELETED` or not yet `READY`, **When** processed, **Then** `duplicateSuspected: false` and no `media.duplicate_suspected` row.
3. **AS-27** (matching rules, pure) — **Given** 64-bit perceptual hashes, **Then**: two hashes at Hamming distance 3 match and at 4 do not; among several candidates the match is the one with the smallest distance, ties broken by the earliest creation (smallest ID, IDs are time-ordered); a hash with fewer than 8 set bits or fewer than 8 clear bits (a blank or near-uniform image) never matches anything and is never matched.
4. **AS-28** (recall guarantee, property) — **Given** any 64-bit hash and any copy of it with at most 3 flipped bits, **Then** the two hashes share at least one of their four 16-bit bands (so a band lookup cannot miss a match); a band lookup that reaches its cap of 500 candidates increments `media_duplicate_scan_truncated_total`.
5. **AS-29** (simultaneous near-duplicates) — **Given** two near-duplicate product photos of two different shops processed at the same moment by two workers, **When** both finish, **Then** both are `READY` and exactly one `media.duplicate_suspected` row exists (the one that committed second flags the one that committed first); neither run fails.

---

### User Story 4 — A seller curates a product gallery (Priority: P1)

A shop member chooses which finished photos belong to a product and in which order. Two members editing at once never silently overwrite each other, only a shop's own finished product photos can be used, and shoppers see the gallery only while the product itself is visible.

**Why this priority**: the gallery is the user-visible result of the whole capability.

**Independent Test**: with a product of shop `A`, ready and unready photos of `A` and of `B`, set, reorder and clear the gallery; replay stale versions; read as a member and as an anonymous visitor.

**Acceptance Scenarios**:

1. **AS-30** (set the gallery) — **Given** an `ACTIVE` product `P` of `ACTIVE` shop `S`, `READY` product photos `m1`, `m2`, `m3` of `S`, and `P` with no gallery (version 0), **When** a member with `products.write` sends `PUT /shops/S/products/P/gallery {mediaIds:[m2,m1,m3], expectedVersion:0}`, **Then** `200 {items:[m2,m1,m3] with positions 0,1,2, version:1}` parsed by `galleryMemberSchema`; three `ProductMedia` rows exist and a version row `1`; one outbox row `media.gallery_changed {productId:P, shopId:S, mediaIds:[m2,m1,m3], galleryVersion:1}` was written in the same transaction; product existence and ownership came from S05 (R1).
2. **AS-31** (replace, reorder, clear, no-op) — **Given** gallery version 1, **When** `PUT {mediaIds:[m1], expectedVersion:1}`, **Then** `200`, version 2, one row, one event; `PUT {mediaIds:[], expectedVersion:2}` clears it: version 3 and an event with an empty list; **When** a `PUT` carries the current list and the current version, **Then** `200` unchanged with the same version, no write and no event.
3. **AS-32** (gallery validation) — **Given** the route, **When** `mediaIds` has more than 20 entries, a duplicate, a non-UUID, is not an array, or is missing; `expectedVersion` is missing, negative or fractional; or the body has any other field; or `shopId` or `productId` in the path is not a UUID, **Then** `400 validation_failed` naming the fields, and no row, version or outbox row changes.
4. **AS-33** (photos that cannot be attached) — **Given** a list that includes: an unknown ID; a photo of another shop; a `review` photo; a photo of `S` that is not `READY`, **When** `PUT`, **Then** `422 media_not_attachable` with `failures:[{mediaId, code}]` where `code` is `not_found` for the unknown, other-shop and review photos (the three are indistinguishable, so another shop's photo IDs cannot be probed) and `not_ready` for `S`'s own unfinished photo; nothing changes.
5. **AS-34** (product checks) — **Given** a product ID that does not exist, or a product of another shop, **When** `PUT`, **Then** the same `404 product_not_found` for both; **Given** `P` is `ARCHIVED`, **Then** `409 product_archived`; **Given** `expectedVersion` differs from the current version, **Then** `409 version_conflict` with `currentVersion`; nothing changes in any case. (Order of checks: auth and shop gate, product, version, body validation of attachability.)
6. **AS-35** (concurrent edits) — **Given** gallery version 1, **When** two members send different valid `PUT`s with `expectedVersion: 1` at the same moment, **Then** exactly one answers `200` (version 2) and the other `409 version_conflict`; the stored gallery is the winner's, and exactly one `media.gallery_changed` row exists.
7. **AS-36** (gallery authorization) — **Given** the write route, **When** called without credentials, **Then** `401`; by a `VIEWER`, `403`; by a non-member or on an unknown shop, the same `404`; on a `SUSPENDED` shop `403 shop_suspended`; on a `DELETING` shop `409 shop_offboarding`; nothing changes.
8. **AS-37** (member read) — **Given** a member with `products.read` (any role), **When** `GET /shops/S/products/P/gallery`, **Then** `200 {items, version}` (also for an `ARCHIVED` product), each item `{mediaId, position, urls, width, height}`; an unknown or foreign product answers the `404` of AS-34.
9. **AS-38** (public read follows product visibility) — **Given** a visible product (`ACTIVE`, not sandbox, shop `ACTIVE`), **When** anyone calls `GET /products/P/gallery`, **Then** `200 {items}` ordered by position with `urls`; **Given** `P` archived, a sandbox product, a product of a `SUSPENDED` or `DELETING` shop, or an unknown product, **Then** an identical `404`; a malformed ID, **Then** `400`; product and shop state come from S05 and S03 (R1), never from their tables.
10. **AS-39** (product deleted event) — **Given** `catalog.product_deleted {productId, shopId, productVersion}` for a product with a gallery, **When** delivered, **Then** its `ProductMedia` and version rows are removed and the photos stay `READY` and unattached; delivered twice → one effect (the second finds nothing to delete); a payload that fails validation (missing `productId`, non-UUID, unknown type, extra version) → dead-lettered with no side effect, the rest of the batch is applied; a delete for a product with no gallery is a no-op.
11. **AS-40** (shop deleted event) — **Given** `tenancy.shop_deleted {shopId}`, **When** delivered, **Then** every photo of the shop that is not already `DELETED` becomes `DELETED` (history rows, one `media.deleted` row each), all gallery rows of that shop are removed; the storage objects are reclaimed later by the purge (AS-53); delivered twice → one effect; an invalid payload → dead-lettered; a `shop_deleted` that arrives before the shop's last in-flight upload completes leaves that photo `DELETED`, and a later worker run for its key answers `SKIPPED` (no resurrection).

---

### User Story 5 — Photos are read quickly and only by those allowed to (Priority: P2)

Shoppers, feeds and the BFF read finished photos by ID in bulk. Unfinished, rejected or deleted photos are visible only to the person who uploaded them (and, for shop photos, to the shop's members).

**Why this priority**: the read path is where the 100k views per second land and where an IDOR would leak private uploads.

**Independent Test**: create photos in every status, read each as the uploader, a shop colleague, a stranger and an anonymous visitor, one by one and in bulk.

**Acceptance Scenarios**:

1. **AS-41** (public read) — **Given** a `READY` photo, **When** anyone calls `GET /media/:id`, **Then** `200` parsed by `mediaPublicSchema` = `{id, status:"READY", purpose, shopId (null for review photos), width, height, urls:{thumb, feed, full}}` with `Cache-Control: public, max-age=15`; each URL starts with the configured media origin and ends in a content-hashed `.webp` path; the body has no `uploaderId`, storage key of an original, `possibleDuplicateOf`, `rejectCode`, `dhash` or history.
2. **AS-42** (non-ready photos are private) — **Given** photos in `PENDING_UPLOAD`, `UPLOADED`, `PROCESSING`, `REJECTED`, `EXPIRED`, `DELETED` and an unknown ID, **When** an anonymous caller or a stranger requests each, **Then** every answer is the identical `404 media_not_found`; **When** the uploader requests their own (and for a shop photo, a member of the shop with `products.read`), **Then** `200` with `mediaOwnerSchema` = the public fields plus `status`, `rejectCode` (only when `REJECTED`), `createdAt`, `updatedAt`, `urls: null` unless `READY`, and `Cache-Control: private, no-store`; a `DELETED` photo is `404` for everyone.
3. **AS-43** (malformed ID) — **When** `GET /media/not-a-uuid`, **Then** `400 validation_failed` with no database statement.
4. **AS-44** (batch read, R2) — **Given** `GET /batch/media?ids=a,b,c,a`, **When** called anonymously, **Then** `200` with an array parallel to the request (`[item, null, item, item]`): an item is a `mediaPublicSchema` object for a `READY` photo and `null` for any other state or unknown ID (no distinction); duplicates are answered from one read; one statement for the whole call; more than 100 IDs or a non-UUID → `400`; headers as AS-41. This is the endpoint `libs/composition/<client>` calls (IX.7 R2) for photo strips on product and feed screens.
5. **AS-45** (exported lookup, R1) — **Given** `MediaQueryService.getReadyMediaByIds(ids, {uploaderId?, shopId?, purpose?})` imported only from `@app/domains/media`, **When** called with up to 500 IDs, **Then** one statement returns a `Map` holding only `READY` photos that satisfy every given predicate (the predicate is part of the query, not checked afterwards); unknown, unready, deleted and non-matching IDs are absent; duplicates collapse; 501 IDs is refused; it returns DTOs `{id, shopId, purpose, width, height, urls, createdAt}`, never a model. A consumer (a future review capability) uses `{uploaderId, purpose:"review"}` to prove the author owns the photos it attaches.
6. **AS-46** (read rate limit, fail open) — **Given** the policy `media.read.ip` (600 per minute per address, fail open), **When** one address sends 601 reads, **Then** the 601st is `429` with `Retry-After`; **Given** the limiter's store is down, **Then** reads are still served and the failure is counted.

---

### User Story 6 — Unused, rejected and deleted photos are cleaned up safely (Priority: P3)

A person can delete a photo; abandoned uploads expire; lost work is re-driven; rejected and deleted files do not pile up, and nothing that is still in use is ever removed.

**Why this priority**: storage cost, privacy (a rejected file must not live forever) and recovery from lost messages.

**Independent Test**: create rows and objects in each state with a frozen clock, run each job twice, and assert rows, objects, history and events.

**Acceptance Scenarios**:

1. **AS-47** (delete a photo) — **Given** a photo in `READY`, `REJECTED`, `PENDING_UPLOAD` or `EXPIRED` that is not in a gallery, **When** its uploader (for a shop photo: a member with `products.write`) calls `DELETE /media/:id`, **Then** `204`; status `DELETED` (history row), one outbox row `media.deleted {mediaId, shopId, purpose}`; `GET` is `404` for everyone immediately and `getReadyMediaByIds` omits it; a second `DELETE` answers the hidden `404`; the objects are reclaimed by AS-53, not by the request.
2. **AS-48** (delete refused) — **Given** a photo that is in a product's gallery, **When** `DELETE`, **Then** `409 media_in_use` with the `productId`s (only for the caller's own shop) and nothing changes; **Given** a photo in `UPLOADED` or `PROCESSING`, **Then** `409 media_busy`; **Given** a `VIEWER` on a shop photo, **Then** `403`; no credentials, `401`.
3. **AS-49** (state machine, pure) — **Given** every pair of statuses, **Then** exactly these transitions exist: `PENDING_UPLOAD → UPLOADED`, `PENDING_UPLOAD → PROCESSING` (storage-notification path), `PENDING_UPLOAD → REJECTED` (size check), `PENDING_UPLOAD → EXPIRED`, `PENDING_UPLOAD → DELETED`, `UPLOADED → PROCESSING`, `PROCESSING → READY`, `PROCESSING → REJECTED`, `PROCESSING → PROCESSING` (lease takeover, attempts + 1), `READY → DELETED`, `REJECTED → DELETED`, `EXPIRED → DELETED`; every other pair is illegal and fails the same way; `DELETED` is final; a switch over the status without `assertNever` does not compile.
4. **AS-50** (late events never resurrect) — **Given** photos that are `REJECTED`, `EXPIRED` and `DELETED`, **When** a late storage notification or queue message for their keys is processed (also a notification that arrives after `complete`, or twice), **Then** the worker answers `SKIPPED`, the row, history and objects are unchanged, and a `complete` on `EXPIRED` is `409 upload_expired` (AS-10). A second upload to the same signed key after `READY` changes nothing that is served (the variants are content-addressed and `READY` is final).
5. **AS-51** (expiry job) — **Given** the job `media.expire-pending-uploads` and photos `PENDING_UPLOAD` created 61 minutes and 59 minutes ago, **When** it runs, **Then** the first becomes `EXPIRED` (history; its object, if any, is deleted) and the second is untouched; a second run changes nothing; two instances running at once expire each photo once (single-run lease).
6. **AS-52** (re-drive job) — **Given** the job `media.requeue-stuck` and: a photo `UPLOADED` for 3 minutes (its queue message was lost), one `UPLOADED` for 1 minute, one `PROCESSING` whose lease expired 10 minutes ago (the worker died and the message went to the dead-letter queue), and one `PROCESSING` with a valid lease, **When** it runs, **Then** exactly the first and third get one new queue message each (at most 100 per run), the others none; running it again within the same minute sends nothing new for them; the processing itself remains idempotent (AS-20, AS-21).
7. **AS-53** (purge job) — **Given** the job `media.purge` and rows `REJECTED`, `EXPIRED` and `DELETED` for 8 days and for 6 days, a variant object referenced by a deleted photo and by a live `READY` photo (identical bytes uploaded twice), and one referenced only by deleted photos, **When** it runs (at most 200 rows per run), **Then** for the 8-day rows: their original objects are deleted, variant objects referenced by no live photo are deleted, the shared variant is kept, and the rows with their history are removed; the 6-day rows are untouched; a failure to delete one object leaves its row for the next run and does not stop the others; a second run changes nothing.
8. **AS-54** (cross-tenant matrix) — **Given** user `U1` with shop `A` member `M1`, user `U2` with shop `B` member `M2`, and photos of `U1` (review) and of `A` (product) in each state, **When** `U2` or `M2` calls `complete`, `DELETE`, `GET` (non-ready), `PUT gallery` with `A`'s photos on `B`'s product, `PUT gallery` on `A`'s product, **Then** every attempt answers the identical `404` (or, for the gallery attachment, the indistinguishable `not_found` failure of AS-33), the data is unchanged, and no response differs between "exists but is not yours" and "does not exist".

---

### User Story 7 — Delivery, events and operations are trustworthy (Priority: P2)

Photos are served only as derived images from a separate origin; other capabilities learn about photos only through versioned events written atomically; operators can see, measure and alert on the pipeline.

**Why this priority**: the security and observability promises of the notes.

**Independent Test**: inspect responses, stored objects and outbox rows; read the metrics registry; start the app with bad configuration.

**Acceptance Scenarios**:

1. **AS-55** (originals are never served) — **Given** photos in every status, **When** any route of this capability answers, **Then** no body, header or URL contains an original's key or a presigned download of it, for any caller including the uploader; every URL is on the configured media origin, which must be a different site from the web app and the API; stored derived objects carry `Content-Type: image/webp` whatever the input was, and their keys never contain a client-supplied name.
2. **AS-56** (events) — **Given** each of the five events, **Then** each is written with `outbox.append` inside the transaction that changed the state (a rolled-back transition leaves no event, a committed one always has it), has the envelope `{eventId, type, version:1, occurredAt, aggregateId}` and a payload that parses with its schema in `mediaEventSchemas`; `media.ready` and `media.deleted` carry `mediaVersion` (the row's version, for guarded read models, IX.8); no event contains an original key, a decoder message or `uploaderId` except where listed in Provides.
3. **AS-57** (observability) — **Given** a processed photo, a rejected photo, a flagged duplicate and a failed attempt, **Then** the metrics registry shows `media_processing_total{result}`, `media_processing_seconds`, `media_upload_to_ready_seconds`, `media_duplicate_suspected_total`, `media_unknown_key_total`, `media_scan_unavailable_total`, `media_processing_attempts_exhausted_total` with the matching increments; every log line of a run is structured, carries `mediaId`, `result`, `attempt`, `durationMs` and the `requestId`/`traceId` copied from the queue message, and never contains image bytes, EXIF values, original file names or full storage keys.
4. **AS-58** (configuration) — **Given** a production configuration with no media origin, a media origin equal to the app's site, no bucket, or no scanner address, **When** the app or the worker starts, **Then** startup fails naming the missing or invalid setting; a non-production configuration may switch the scanner off explicitly, and then logs a warning at startup.
5. **AS-59** (boundary and ownership, static) — **Given** the repository, **When** `pnpm check:table-ownership --strict` and `pnpm check:boundaries` run, **Then** `media` has 0 findings: no SQL, model or join on `Product`, `Shop`, `User` or any table it does not own; `Media`, `MediaStatusHistory`, `ProductMedia` and `ProductGallery` are registered to `domain:media`; no foreign key leaves them; the barrel exports only what this spec's Provides lists, and a test module that imports only `@app/domains/media` can use every export.
6. **AS-60** (storage tiers and delivery headers, operations) — **Given** the deployed bucket and CDN, **Then** originals are private and move to infrequent-access storage after 30 days and to archive after 180; the media origin answers variants with `X-Content-Type-Options: nosniff`, the immutable cache header and no cookies; incomplete multipart or abandoned uploads are aborted by a lifecycle rule. Proven by the infrastructure code and a post-deploy check, not by an API test.
7. **AS-61** (load, operations) — **Given** 600 upload requests per second, **Then** sellers and buyers receive their upload permission in under 300 ms at the 95th percentile with no image byte on the API; a 1,000-image run through the worker shows throughput scaling with workers. Proven by the k6 script and the throughput script, not by an API test.

---

### Edge Cases

Every edge case below is one of the scenarios above:

- Wrong, disguised or oversized files (AS-06, AS-08, AS-16, AS-17); decompression bombs (AS-16); malware and a scanner outage (AS-18, AS-19).
- Duplicate, concurrent and out-of-order delivery of storage notifications and queue messages (AS-09, AS-11, AS-20, AS-21, AS-50); a worker that dies mid-run (AS-21, AS-52); poison files (AS-22); slow storage (AS-23); partial writes (AS-24).
- Concurrent `complete`, gallery `PUT` and near-duplicate processing (AS-09, AS-35, AS-29).
- Illegal state transitions (AS-10, AS-48, AS-49, AS-50) and idempotent replay (AS-09, AS-31, AS-39, AS-40, AS-47).
- Cross-tenant and cross-user access (AS-03, AS-34, AS-36, AS-42, AS-54).
- Limits: size, pixels, frames, 20 gallery photos, pending-upload quota, rate limits, batch sizes (AS-04, AS-05, AS-16, AS-32, AS-44, AS-45, AS-46).
- Time: presign expiry, upload slot expiry, lease expiry, purge age (AS-01, AS-51, AS-21, AS-52, AS-53).
- Product or shop deleted while photos are attached or uploading (AS-39, AS-40).

## Requirements *(mandatory)*

### Functional Requirements

**Upload**

- **FR-001**: Two upload requests exist: product photos by a member of a shop with `products.write`, and review photos by a signed-in user; the accepted purposes are exactly `product` and `review` (AS-01, AS-02, AS-03).
- **FR-002**: The storage location of every original is chosen by the server (`media/originals/shops/<shopId>/<uuid>` or `media/originals/users/<userId>/<uuid>`); no client input becomes part of a key (AS-01, AS-55).
- **FR-003**: The signed upload permission binds the exact key, the allowed content types (JPEG, PNG, WebP, AVIF), a body between 1 byte and 15,728,640 bytes, and an expiry of 10 minutes; the platform enforces nothing about bytes itself and receives none (AS-01, AS-06).
- **FR-004**: Requesting an upload creates a `PENDING_UPLOAD` record and its first history row in one transaction, and the signature is a local computation, so no storage or queue call happens inside the transaction (AS-01).
- **FR-005**: An uploader may hold at most 50 photos in `PENDING_UPLOAD` per scope (shop or personal) (AS-04).
- **FR-006**: Upload requests are rate limited per user (30/min) and per shop (120/min), failing closed (AS-05).
- **FR-007**: Authorization follows S03 for shop uploads (`products.write`, status gate, hidden shop existence) and authentication for review uploads (AS-03).
- **FR-008**: `complete` is allowed only for the uploader (and, for a shop photo, only while they still hold `products.write` in that shop); it checks the object exists and has a valid size, moves `PENDING_UPLOAD → UPLOADED` conditionally, and sends one queue message after commit; it is idempotent and safe under concurrency; replays answer from the current state (AS-07–AS-10).
- **FR-009**: The processing worker also accepts the storage's own object-created notification and a manual `{originalKey}` message; keys outside `media/originals/` are ignored (AS-11).

**Processing**

- **FR-010**: The worker claims a photo with one conditional update (`PENDING_UPLOAD|UPLOADED → PROCESSING`, or `PROCESSING → PROCESSING` only when the 5-minute lease has expired) that records the lease and increments `attempts`; a photo whose lease is valid answers `BUSY`; every other status answers `SKIPPED` (AS-20, AS-21).
- **FR-011**: The real format is determined from the bytes; the declared content type and any file name are ignored; the allowed formats are JPEG, PNG, WebP and AVIF (AS-16, AS-17).
- **FR-012**: Limits: at most 50,000,000 pixels (decided from the header), a single frame, at least 1 pixel in each dimension, and the object size of FR-003 re-checked at completion (AS-08, AS-16).
- **FR-013**: Every original is scanned for malware before any variant is written; an infection rejects the photo and deletes the original; an unreachable scanner is a transient failure; in production a photo never becomes `READY` unscanned (AS-18, AS-19, AS-58).
- **FR-014**: The EXIF orientation is applied, then all metadata (EXIF, GPS, XMP, IPTC, ICC, thumbnails, comments) is dropped, and the pixels are converted to sRGB (AS-12, AS-13).
- **FR-015**: Three WebP variants are produced: `thumb` 200 px, `feed` 640 px, `full` 1600 px wide, never upscaled, aspect ratio kept (AS-12, AS-14).
- **FR-016**: Variant objects are named by the hash of their bytes, written with an immutable one-year cache header and `image/webp`; the same input always gives the same keys; writing twice is harmless (AS-12, AS-15).
- **FR-017**: A photo becomes `READY` only after all three variant objects are confirmed to exist; the status change, the history row, the duplicate result and the `media.ready` outbox row are written in one transaction, with no storage or queue call inside it (AS-12, AS-24, AS-56).
- **FR-018**: Rejection writes status `REJECTED`, one stable code from the closed vocabulary of AS-16, a history row and `media.rejected`; decoder messages are logged, never stored or returned (AS-16, AS-17).
- **FR-019**: A transient failure (storage, scanner, timeout, database) ends the run without acknowledging the message, leaves the photo `PROCESSING`, and is retried by the queue; at the fifth claim the photo is rejected with `processing_failed` and the message is acknowledged (AS-19, AS-22).
- **FR-020**: Every external call has a timeout: reading the original 20 s, each variant write 10 s, the scanner 15 s, and 45 s for one image's whole run; retries happen only through the queue, never inside the worker (AS-23).

**Duplicate detection**

- **FR-030**: A 64-bit perceptual hash of the oriented image is stored for every `product` photo; `review` photos are neither hashed for matching nor candidates (AS-25, AS-26).
- **FR-031**: At the `READY` transition the hash is compared with `READY` product photos of other shops (same-shop photos are ignored); a match is Hamming distance ≤ 3; the nearest match wins, ties by earliest creation; near-uniform hashes (fewer than 8 set or clear bits) never match (AS-26, AS-27).
- **FR-032**: Candidates are found by four indexed 16-bit bands (distance ≤ 3 guarantees a shared band); each band lookup is capped at 500 and a hit of the cap is counted (AS-28).
- **FR-033**: The scan and the status change are serialised per band so that two simultaneous near-duplicates cannot both miss each other (AS-29).
- **FR-034**: A suspicion is advisory: it never blocks `READY`, attachment or serving; it is recorded privately and published as `duplicateSuspected` (no identifier) on `media.ready` and as `media.duplicate_suspected` (with identifiers, for moderation); no API exposes it (AS-25).

**Gallery**

- **FR-040**: A product has an ordered gallery of at most 20 `READY` product photos of its own shop; position 0 is the primary image; the whole gallery is replaced by one `PUT` carrying `expectedVersion` (AS-30–AS-32).
- **FR-041**: Attachability is checked inside the write transaction: unknown, other-shop and wrong-purpose photos fail as `not_found`; the shop's own non-`READY` photos fail as `not_ready` (AS-33).
- **FR-042**: The product comes from S05 (R1 `getProductsByIds([id], {shopId})`), never from its table; a missing or foreign product is `404 product_not_found`; an archived one is `409 product_archived` (AS-34).
- **FR-043**: The gallery has its own version (0 when none); a stale version is `409 version_conflict` with `currentVersion`; two concurrent writers cannot both win; a no-op write changes nothing (AS-31, AS-35).
- **FR-044**: Every gallery change writes `media.gallery_changed` with the full ordered list and `galleryVersion` (AS-30, AS-31).
- **FR-045**: The public gallery read is available only while the product is visible (S05 `ACTIVE`, not sandbox, S03 shop `ACTIVE` and not sandbox), otherwise an indistinguishable `404`; the member read is available for archived products too (AS-37, AS-38).
- **FR-046**: Deleting a product (`catalog.product_deleted`) removes its gallery; deleting a shop (`tenancy.shop_deleted`) deletes its photos and galleries; both consumers are idempotent, validate their payloads and dead-letter poison messages (AS-39, AS-40).

**Read**

- **FR-050**: `GET /media/:id` shows a `READY` photo to anyone; every other state only to the uploader and, for shop photos, to members with `products.read`; everybody else gets the one `404` (AS-41, AS-42).
- **FR-051**: Public and owner views never contain an original's key, the duplicate match, the perceptual hash, the uploader of someone else's photo, or a decoder message (AS-41, AS-55).
- **FR-052**: `GET /batch/media?ids=` (≤ 100, anonymous, rate limited) is the R2 target; `getReadyMediaByIds` is the R1 lookup with a predicate pushed into the query (AS-44, AS-45).
- **FR-053**: Read routes are rate limited per address (600/min), failing open (AS-46).
- **FR-054**: Every URL returned is on the configured media origin and points at a derived object (AS-41, AS-55).

**Lifecycle**

- **FR-060**: A photo moves only along the transitions of AS-49, by a conditional update that asserts one affected row, with a history row in the same transaction; `DELETED` is final (AS-49, AS-50).
- **FR-061**: A photo can be deleted by its uploader or, for shop photos, by a member with `products.write`, unless it is in a gallery (`media_in_use`) or being processed (`media_busy`) (AS-47, AS-48).
- **FR-062**: Upload slots not completed within 60 minutes expire (job `media.expire-pending-uploads`, every 5 minutes) (AS-51).
- **FR-063**: Photos `UPLOADED` for more than 2 minutes, or `PROCESSING` with a lease expired for more than 10 minutes, are re-sent to the queue by `media.requeue-stuck` (every minute, ≤ 100 per run) (AS-52).
- **FR-064**: `media.purge` (hourly, ≤ 200 rows per run) removes, 7 days after the terminal status, the original objects, the variant objects no live photo references, and finally the rows and their history (AS-53).
- **FR-065**: Originals are retained privately and tiered to cheaper storage by age (ops, AS-60).

**Security and delivery**

- **FR-070**: Originals are never readable by any API caller; only derived images are served, from a media origin that is a different site from the web app and the API; the media origin sends `nosniff` and the stored type is always `image/webp` (AS-55, AS-60).
- **FR-071**: Cross-tenant and cross-user access is always `404`, never `403`, and never distinguishable from "does not exist" (AS-54).
- **FR-072**: SQL is parameterised and every lookup of an owned record carries the principal (uploader or shop) in its predicate (AS-54).
- **FR-073**: All request and response bodies are explicit DTOs parsed by schemas in `packages/contracts`; errors are problem+json with stable codes: `validation_failed` 400, `permission_denied` 403, `shop_suspended` 403, `media_not_found` 404, `product_not_found` 404, `shop_offboarding` 409, `upload_incomplete` 409, `upload_expired` 409, `pending_uploads_limit` 409, `media_in_use` 409, `media_busy` 409, `product_archived` 409, `version_conflict` 409, `media_not_attachable` 422 (all scenarios).

**Events**

- **FR-080**: Five events are written to the outbox in the transaction that changes the state: `media.ready`, `media.rejected`, `media.deleted`, `media.gallery_changed`, `media.duplicate_suspected`; each has an `aggregateId` and a schema; `mediaVersion` increases with every transition (AS-56).

**Operations**

- **FR-090**: The pipeline exposes the metrics and structured logs of AS-57, and carries the request or trace ID from the queue message into every log line.
- **FR-091**: Configuration is validated at startup (AS-58).
- **FR-092**: Jobs are single-run across replicas (S49) (AS-51–AS-53).

**Data ownership**

- **FR-100**: `media` owns `Media`, `MediaStatusHistory`, `ProductMedia`, `ProductGallery` (and `Video`, `VideoTask` of S30); it reads no table it does not own, has no foreign key to another owner's table, and reaches other domains only by R1 (S05 `getProductsByIds`; S03 `assertMember`, `getShopsByIds`), R2 (batch route) and R3 (the two event consumers) (AS-59).

### Key Entities

- **Photo (`Media`)**: id, purpose (`product` or `review`), the shop it belongs to (none for review photos), the uploader, status, the private original's location, the three variants (key, width, height), source width and height, perceptual hash with its four bands, the private duplicate suspicion (match, distance, time), a rejection code, the attempt count and lease, a version, timestamps.
- **Photo history (`MediaStatusHistory`)**: photo, from, to, actor (user, system, or the worker), time, rejection code.
- **Gallery link (`ProductMedia`)**: product, photo, position (0-based, unique within the product).
- **Gallery version (`ProductGallery`)**: product, shop, version, updated time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 95% of valid photos up to 5 MB are viewable (READY) within 10 seconds of the upload being confirmed, with the worker pool idle-to-busy at 1,000 photos in the queue.
- **SC-002**: 100% of served variants in a 1,000-image corpus (including 100 carrying GPS) contain no location, camera or owner metadata.
- **SC-003**: 100% of non-image, disguised, oversized (> 50 MP) and infected files in the test corpus are refused before any public address exists for them.
- **SC-004**: 100% of the fixture corpus's re-saved copies (half size, quality 55, re-encoded) are flagged as suspected duplicates; 0 same-shop re-uploads and 0 review photos are flagged.
- **SC-005**: Sellers and buyers get their upload permission in under 300 ms (95th percentile) at 600 requests per second, and no image byte is received by the API.
- **SC-006**: Delivering the same upload notification any number of times, or from two workers at once, produces exactly one finished photo and one `media.ready` event, in 100% of the replay and race tests.
- **SC-007**: 0 photos of another person or shop are readable, completable, deletable or attachable by a stranger in the cross-tenant matrix (AS-54); responses for "not yours" and "does not exist" are byte-identical apart from the request ID.
- **SC-008**: No unfinished, rejected or deleted file lives longer than 8 days after reaching that state, and 0 variant objects still referenced by a live photo are removed.
- **SC-009**: A gallery edit by two people at once never loses an edit silently: in 100% of the concurrency tests exactly one wins and the other is told to refresh.

## Cross-capability contracts

Earlier specs searched (`grep` over `specs/domains` for `S29` and `media`; `specs/web` and `specs/journeys` do not exist yet): **S05** requires from S29 the gallery links (`ProductMedia`) and lists S29 as a consumer of `getProductsByIds` with `{shopId}` (honoured: FR-042); the domain map and the ownership registry still give `ProductMedia` to `catalog`, which conflicts, so S29 asks for the move (a `[CONTRACT]` question). **S25** says photos in posts are out of scope, that the media upload comment promises a link it does not provide, and that `discussion.write` must stop being borrowed by media (honoured: `post` is dropped, own policies). **S07** says its malware scanner may later move to an infrastructure library if media needs it (a `[CONTRACT]` question). **S27** and **S08** point images to S29 but ask for nothing in this release. No other spec names a requirement from S29.

**Provides** (exact names; exported from `@app/domains/media` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json with `code`, schemas in `packages/contracts`: `mediaUploadRequestSchema` (`{purpose}`), `mediaUploadResponseSchema` (`{mediaId, upload:{url, fields, expiresAt}, maxBytes, allowedContentTypes}`), `mediaOwnerSchema`, `mediaPublicSchema` (`{id, status:"READY", purpose, shopId: string | null, width, height, urls:{thumb, feed, full}}`), `mediaBatchItemSchema` (= `mediaPublicSchema | null`), `galleryPutRequestSchema` (`{mediaIds: string[≤20], expectedVersion}`), `galleryMemberSchema` (`{items:[{mediaId, position, urls, width, height}], version}`), `galleryPublicSchema` (`{items}`), `mediaEventSchemas`.
  - `POST /media/uploads` (signed-in; `purpose: "review"`) → `201`; `POST /shops/:shopId/media/uploads` (`products.write`; `purpose: "product"`) → `201`; `POST /media/:id/complete` → `202 {status}` or `200 {status, rejectCode?}`; `GET /media/:id` (anonymous or owner) → public or owner view; `DELETE /media/:id` → `204`.
  - `GET /batch/media?ids=` (anonymous, ≤ 100 ids; the BFF's R2 target) → array of `mediaBatchItemSchema`.
  - `PUT /shops/:shopId/products/:productId/gallery` (`products.write`) → `200 galleryMemberSchema`; `GET /shops/:shopId/products/:productId/gallery` (`products.read`) → `galleryMemberSchema`; `GET /products/:productId/gallery` (anonymous, visible products only; an R2 target for the product page) → `galleryPublicSchema`.
- `MediaQueryService` (R1): `getReadyMediaByIds(ids: MediaId[], options?: { uploaderId?: UserId; shopId?: ShopId; purpose?: 'product' | 'review' }): Promise<Map<MediaId, MediaDto>>` (≤ 500; one statement; only `READY`; predicates inside the query); `MediaDto = { id, shopId: ShopId | null, purpose, width, height, urls: { thumb, feed, full }, createdAt }`. **Consumers: a future review capability, S25/S26 (if posts or feed items ever carry photos), S32 (primary image of a product in the index, via `media.gallery_changed` rather than polling), the BFF composition for photo strips.**
- Events (outbox → topic `media.events`, key `aggregateId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`):
  - `media.ready` `{mediaId, mediaVersion, shopId: string | null, uploaderId, purpose, width, height, variants: {thumb|feed|full: {key, width, height}}, duplicateSuspected: boolean}`; **BREAKING:** `possibleDuplicateOf` is removed.
  - `media.rejected` `{mediaId, mediaVersion, shopId, uploaderId, purpose, code}` (code from the closed vocabulary of AS-16). Consumers: S28 may notify the uploader.
  - `media.deleted` `{mediaId, mediaVersion, shopId, purpose}`. Consumers drop their references.
  - `media.gallery_changed` (aggregateId = `productId`) `{productId, shopId, mediaIds: string[] (ordered), galleryVersion}`. Consumers: S32 (product image in the search index), S26 (feed card image), S43 (webhooks `product.updated` image changes, optional).
  - `media.duplicate_suspected` `{mediaId, shopId, matchedMediaId, matchedShopId, distance}`. Moderation only; no consumer in this release.
- `createMediaProcessor(deps): { process(originalKey): Promise<'READY' | 'REJECTED' | 'SKIPPED' | 'BUSY'> }` — the framework-free worker core that `apps/lambdas` wires with its database, storage and scanner adapters (replaces exporting `MediaProcessor` and `Sql`, D-8).
- Modules for the apps: `MediaModule` (core: HTTP, R1 service), `MediaWorkerModule` (worker: the three jobs), `MediaProjectorModule` (projector: the two consumers). `VideoModule` and `VideoWorkerModule` stay exported for S30. Nothing else is exported (no model, repository, `MediaProcessor`, `Sql`, `MEDIA_QUEUE`).
- Queue: `media-processing` carries `{mediaId, originalKey}` (from this capability), the storage's native notification, or a manual `{originalKey}`; the worker is idempotent for all three.
- Rate-limit policies (declared in S50's registry): `media.upload.user` 30/min per user (fail closed), `media.upload.shop` 120/min per shop (fail closed), `media.gallery.shop` 60/min per shop (fail closed), `media.read.ip` 600/min per address (fail open). `discussion.write` is no longer used by media.
- Scheduled jobs (registered with S49): `media.expire-pending-uploads` (every 5 min), `media.requeue-stuck` (every minute), `media.purge` (hourly).
- Ownership registry: `Media`, `MediaStatusHistory`, `ProductMedia`, `ProductGallery` → `domain:media`.

**Requires**:

- **S03** (`tenancy`): `ShopScoped(permission)` with `products.read` and `products.write` and the status gate (`403 shop_suspended`, `409 shop_offboarding`, hidden shop existence); `ShopAccessService.assertMember(shopId, userId, permission): Promise<{ role }>` (throws not-found / forbidden); `ShopQueryService.getShopsByIds(ids): Promise<Map<ShopId, ShopSummaryDto>>` with `status` and `isSandbox`; event `tenancy.shop_deleted` v1 `{shopId}`.
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[], options?: { shopId?: ShopId }): Promise<Map<ProductId, ProductDto>>` with `status: 'ACTIVE' | 'ARCHIVED'`, `isSandbox`, `shopId`; event `catalog.product_deleted` v1 `{productId, shopId, productVersion}`. **Ownership move (CONTRACT):** `ProductMedia` leaves catalog's registry entry and becomes media's.
- **S01** (`identity`): the authentication guard (`Firewall`) that provides the signed-in user's ID; no role is needed for review photos.
- **S53**: `outbox.append(event)` in the domain's transaction; the consumer framework (envelope check, zod validation, DLQ, version guard or inbox); the queue port with a delivery count for the attempt rule.
- **S49**: single-run scheduled jobs with leases. **S50**: the four policies. **S54**: problem+json filter with `code`, request context, metrics registry, startup config validation, structured logging with trace propagation from the queue message.
- **Infrastructure ports (no S-capability owns them; the implementation extends them, `questions.md`)**: object storage — `presignPost` with an exact list of content types, an exact key and a minimum body size; `put` with a cache-control argument; `head` returning size and content type; `delete`; `getStream` with a read timeout. A **malware scanner port** with a timeout (today `catalog-sync` owns the adapter; it moves to `libs/infrastructure/antivirus` and S07 switches to it, no change to S07's contracts). Task queue port: `enqueue` and the receive count.
- **Web (W04)**: the seller gallery screen calls the endpoints above; its error handling reads the `code` values of FR-073.

## Assumptions

- Photos only: formats are JPEG, PNG, WebP and AVIF in; WebP out. HEIC/HEIF is not accepted (browsers and phones convert on upload, and the HEVC decoder is not part of the standard image library). AVIF output is not produced (encode cost; WebP is universally supported by the clients of this marketplace).
- The 15 MiB original limit, the 50-megapixel limit, 3 variant widths (200/640/1600), WebP quality 80, the 600-second signature life, 50 pending uploads, 5-minute lease, 5 attempts, 60-minute upload expiry, 7-day purge, 20 gallery photos, Hamming distance 3 and the 500-candidate cap are defaults taken from the notes and the existing code; they are configuration, not contract.
- Product photos belong to a shop; review photos belong to a person. A review photo is public once `READY` (reviews are public); there is no private-photo tier in this release, so delivery uses the public immutable media origin, not signed URLs.
- Duplicate detection is a signal for trust and safety, never a gate. It reveals nothing about the other party to either seller. Simultaneous near-duplicates are handled by serialising the scan (FR-033).
- A late second upload to a still-valid signed key after `READY` can overwrite the private original but cannot change anything served: variants are content-addressed and `READY` is final. The signature life (10 minutes) bounds the window.
- Reviews and posts do not exist as capabilities that attach photos in this release; they will use `getReadyMediaByIds` with the `{uploaderId, purpose}` predicate and the three events. No `post` purpose is offered.
- The processing worker may run as a serverless function or as a worker process; the contract is the same (`createMediaProcessor`).
- The tiering rule (30 days, 180 days) and the CDN headers are an operations artifact (AS-60), outside the API test suite.
- The decisions behind every default are listed in `questions.md`; the ones that change behaviour that exists today are tagged `[BREAKING]` there.
