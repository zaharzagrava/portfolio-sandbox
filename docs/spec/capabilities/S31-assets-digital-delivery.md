---
id: S31
title: Shop asset library (chunked dedupe, delta sync, conflicts, share links) and digital product delivery
kind: capability
status: draft
generated_at: 014717cf
depends_on: [S01, S03, S05, S10, S49, S50, S51, S53, S54]
concepts: [problem-json-errors, outbox-task-queue, tenant-shop-rbac, transaction-runner, rate-limit-policy, idempotency-key]
models: [asset-status, entitlement-status]
scope:
---
# S31 - Shop asset library (chunked dedupe, delta sync, conflicts, share links) and digital product delivery

## Purpose
A shop keeps an asset library (brand kits, manuals, product files up to 50 GiB) that its team's devices keep in sync, and it can sell a file as a digital product. A sync client splits a file into content-defined chunks; the platform stores each chunk once per shop, a file version is an ordered list of chunk hashes, and the bytes of an upload never pass through the application. Devices ask what changed since a cursor, edit offline, and a stale save becomes a conflicted copy instead of a lost update. A shop can hand out expiring, capped share links. After a buyer pays for a digital product they download the file through a short-lived link tied to them, and a refund takes the right away.

## Entry points
- Library (needs a shop role with `products.read` for reads, `products.write` for writes): prepare an upload, commit a version, list the library, read the change journal, list versions, read a manifest, delete and undelete an asset, delete a version, restore a version.
- Share links: create, list and revoke by an owner; anonymous preview and redeem of a link; anonymous download by grant token.
- Digital products: link, read, re-link and unlink a file of a product; a buyer lists their purchases and asks for a download link.
- Consumed events: `order.paid`, `order.refunded` (topic `orders.events`), `catalog.product_deleted`, `tenancy.shop_deleted`.
- Published events (topic `assets.events`): `assets.entitlement_granted`, `assets.entitlement_revoked`, `assets.digital_product_linked`, `assets.digital_product_unlinked`.
- Realtime: `assets.changed {lastSeq}` on `shop:<shopId>:assets`.
- Scheduled jobs: `assets.gc-chunks`, `assets.purge-deleted-assets`, `assets.purge-download-grants`, `assets.purge-changes`.

## Rules
- **S31.R-01** A prepare call takes 1 to 5,000 chunk references of a 64-character lower-case SHA-256 and a size of 1 byte to 16 MiB, collapses duplicates and answers only the chunks the shop does not hold, each with a 900-second upload permission bound to its hash and size; any other body answers `400 validation_failed` and persists nothing. [proof: S31 AS-01, S31 AS-03] [code: packages/backend/libs/domains/asset-library/application/upload.service.ts#UploadService]
- **S31.R-02** Chunks are deduplicated per shop only: a shop's answer never reveals whether another shop holds a hash. [proof: S31 AS-02]
- **S31.R-03** A chunk counts as stored only when its bytes are confirmed in storage, and a chunk reported stored is protected from cleanup for 24 more hours. [proof: S31 AS-05, S31 AS-42]
- **S31.R-04** A hash has one size: prepare with another size for a known hash answers `422 chunk_size_mismatch`. [proof: S31 AS-04]
- **S31.R-05** Prepare reserves new bytes against the shop quota atomically, so stored plus reserved bytes never exceed the quota (default 100 GiB), and a prepare that adds no bytes is never refused for quota (`409 quota_exceeded`). [proof: S31 AS-14, S31 AS-15]
- **S31.R-06** Commit needs an `Idempotency-Key` of 8 to 128 characters, scoped per shop and user for 24 hours: a replay returns the [stored answer](../terms/idempotency-stored-answer.md) with `Idempotency-Replayed: true`, a key in flight answers `409 idempotency_in_flight`, the same key with another body answers `422 idempotency_key_reuse`. [proof: S31 AS-09, S31 AS-12] [code: packages/backend/libs/domains/asset-library/api/library.controller.ts#LibraryController]
- **S31.R-07** Paths start with `/`, are at most 1,000 characters with segments of at most 255, have no empty, `.` or `..` segment, no trailing slash, no NUL, backslash or control character, are stored in NFC form and are case-sensitive. [proof: S31 AS-09, S31 AS-78] [code: packages/backend/libs/domains/asset-library/domain/asset-path.ts#validateAssetPath]
- **S31.R-08** Commit checks, before changing anything, that every chunk is known to the shop and present in storage and that the sizes add up (`422 chunks_unknown`, `422 chunk_not_uploaded`, `422 size_mismatch`); a failed commit persists nothing. [proof: S31 AS-10]
- **S31.R-09** A successful commit writes the version, raises each chunk's reference count by its occurrences and appends one journal entry in one transaction, and publishes the change notification only after the commit. [proof: S31 AS-07, S31 AS-33]
- **S31.R-10** A commit answers one of `created`, `updated`, `conflicted_copy` (all `201`) or `unchanged` (`200`, no state change); a zero-byte file is valid. [proof: S31 AS-07, S31 AS-11, S31 AS-13]
- **S31.R-11** No storage call happens while a database transaction is open; a storage failure or timeout on the commit path answers `503 storage_unavailable` with `Retry-After` and persists nothing. [proof: S31 AS-16, S31 AS-17]
- **S31.R-12** An asset has at most 500 versions (`409 version_limit_reached`). [proof: S31 AS-45]
- **S31.R-13** Of any number of commits on one base exactly one updates the asset; the others become conflicted copies named `<name> (conflicted copy <deviceId> <UTC date>)<extension>` with ` (2)`, ` (3)` appended when taken, and a conflicted copy never writes into an existing asset. [proof: S31 AS-21, S31 AS-22, S31 AS-23, S31 AS-24, S31 AS-25] [code: packages/backend/libs/domains/asset-library/domain/conflict-name.ts#conflictedCopyPath]
- **S31.R-14** A commit on a path with no live asset and a positive base creates the asset; a base above the current version of a live asset answers `422 invalid_base_version`. [proof: S31 AS-26, S31 AS-27]
- **S31.R-15** Every visible change appends exactly one gapless per-shop journal entry in commit order; deleting a non-current version and unchanged saves add none. [proof: S31 AS-28, S31 AS-29, S31 AS-35] [code: packages/backend/libs/domains/asset-library/infra/journal.repository.ts#SequelizeJournalRepository]
- **S31.R-16** The journal is read with a required opaque cursor and a limit of 1 to 1,000; a malformed or future cursor answers `422 invalid_cursor` and a cursor older than the retained journal (90 days) answers `410 cursor_expired`. [proof: S31 AS-28, S31 AS-30, S31 AS-76]
- **S31.R-17** The listing is keyset-paginated by path then ID with limit 1 to 100, a literal prefix, `deleted=true` for tombstones in the undelete window, and `syncCursor` on the first page. [proof: S31 AS-31] [code: packages/backend/libs/domains/asset-library/application/library.service.ts#LibraryService]
- **S31.R-18** The manifest lists a version's chunks in order, paginated by index, each with a 600-second download URL, for a live asset only. [proof: S31 AS-32]
- **S31.R-19** After every journaled change the library publishes `assets.changed {lastSeq}` on the shop asset topic, best effort: a hub failure never fails the change and is counted. [proof: S31 AS-33]
- **S31.R-20** A version listing is newest first without chunk hashes; the current version and the only version cannot be deleted (`409 cannot_delete_current_version`); restoring a version creates a new version from its chunk list with the commit's base check. [proof: S31 AS-34, S31 AS-35, S31 AS-36, S31 AS-37]
- **S31.R-21** An asset moves `ACTIVE → DELETED → PURGED` through conditional transitions (`409 invalid_transition` otherwise); delete is refused while the asset is linked or entitled (`409 asset_in_use`); undelete is allowed for 30 days and refused when another live asset holds the path (`409 path_taken`). [proof: S31 AS-38, S31 AS-39] [code: packages/backend/libs/domains/asset-library/domain/asset-status.ts#assetTransition]
- **S31.R-22** Purge removes a deleted asset 30 days after deletion, releases its versions' chunk references exactly once and removes its share links. [proof: S31 AS-40]
- **S31.R-23** A chunk's reference count equals its occurrences across all versions of the shop, changes only in the transaction of the version change and never goes below zero. [proof: S31 AS-44]
- **S31.R-24** Cleanup removes only chunks with count 0, unreferenced and unprotected for more than 24 hours; it deletes the object first and the row second, keeps the row when the delete fails, and never leaves a committed version pointing at a [missing object](../terms/missing-object.md). [proof: S31 AS-41, S31 AS-42, S31 AS-43] [code: packages/backend/libs/domains/asset-library/application/cleanup.service.ts#CleanupService]
- **S31.R-25** A share link needs `products.write` and a live asset, `expiresInHours` 1 to 720 and optional `maxDownloads` 1 to 10,000; the token has at least 192 random bits, only its digest is stored, and the status is derived (`ACTIVE`, `EXPIRED`, `EXHAUSTED`, `REVOKED`). [proof: S31 AS-46, S31 AS-47, S31 AS-52] [code: packages/backend/libs/domains/asset-library/application/share.service.ts#ShareService]
- **S31.R-26** Preview never changes state; redeem checks expiry, revocation, cap and the live asset and increments the counter in one conditional update, so the cap is never exceeded; every unavailable reason answers the same `410 link_unavailable`; a link is expired at and after `expiresAt`. [proof: S31 AS-48, S31 AS-50, S31 AS-51, S31 AS-53]
- **S31.R-27** A redeem or purchase request issues an opaque grant (digest stored) pinned to the version at issue time, valid 120 s (share) or 600 s (purchase); fetching it changes nothing, may repeat, re-checks the link or entitlement and the asset, and answers one uniform `410 download_unavailable` for every failure. [proof: S31 AS-49, S31 AS-52, S31 AS-54, S31 AS-69] [code: packages/backend/libs/domains/asset-library/application/delivery.service.ts#DeliveryService]
- **S31.R-28** Downloads are attachments from the user-content origin with `application/octet-stream`, `nosniff`, `no-store`, `Referrer-Policy: no-referrer` and no cookie, the file name built by a pure rule; the first chunk is opened before any header (`503` otherwise) and a later failure aborts the connection. [proof: S31 AS-55, S31 AS-56, S31 AS-57] [code: packages/backend/libs/domains/asset-library/domain/content-disposition.ts#attachmentHeader]
- **S31.R-29** A member with `products.write` links one live asset of the shop to one product of the shop (the product is checked through the catalog's batch lookup), re-links (active entitlements move in the same transaction) and unlinks; unlinking is refused while any entitlement exists (`409 digital_product_sold`). [proof: S31 AS-59, S31 AS-60] [code: packages/backend/libs/domains/asset-library/application/digital.service.ts#DigitalService]
- **S31.R-30** `order.paid` creates exactly one entitlement per order and product for every line whose product is linked in the line's own shop and publishes `assets.entitlement_granted`; `order.refunded` revokes every entitlement of the order once; a refund recorded before or after the paid event leaves no active entitlement; malformed payloads are dead-lettered without effect. [proof: S31 AS-61, S31 AS-62, S31 AS-63, S31 AS-64, S31 AS-65] [code: packages/backend/libs/domains/asset-library/infra/orders.consumer.ts#AssetOrdersConsumer] [code: packages/backend/libs/domains/asset-library/application/entitlement.service.ts#EntitlementService]
- **S31.R-31** A buyer lists active entitlements by keyset pages and asks for a download link; a missing, revoked, foreign or unknown entitlement answers the same `404 entitlement_not_found`; each issued link counts a download and carries `X-Licensed-To`. [proof: S31 AS-66, S31 AS-67, S31 AS-68] [code: packages/backend/libs/domains/asset-library/application/purchases.service.ts#PurchasesService]
- **S31.R-32** `catalog.product_deleted` removes the product's link once and keeps entitlements working; `tenancy.shop_deleted` purges the shop's library and revokes its entitlements. [proof: S31 AS-70, S31 AS-71] [code: packages/backend/libs/domains/asset-library/infra/catalog-shop.consumer.ts#AssetCatalogShopConsumer]
- **S31.R-33** Every shop route uses the tenancy guard with `products.read` for reads and `products.write` for writes, a record outside the caller's scope answers `404`, and a member of another shop gets `404 shop_not_found`. [proof: S31 AS-19, S31 AS-20]
- **S31.R-34** Rate limits: `assets.upload.shop` 120 per minute per shop (fail closed), `assets.redeem.ip` 60 per minute per address (fail open), `assets.grant.user` 30 per minute per user (fail closed); each answers `429 rate_limited` with `Retry-After`. [proof: S31 AS-18, S31 AS-58, S31 AS-72] [code: packages/backend/libs/domains/asset-library/rate-limit-policies.ts#assetRatePolicies]
- **S31.R-35** Expiries, caps, grace periods and retention read the platform clock, so tests can freeze and advance it. [proof: S31 AS-41, S31 AS-51, S31 AS-69]
- **S31.R-36** The four scheduled jobs run once per schedule and are idempotent; journal entries older than 90 days are purged and the retention floor is recorded. [proof: S31 AS-75, S31 AS-76] [code: packages/backend/libs/domains/asset-library/infra/assets.jobs.ts#AssetsJobs]
- **S31.R-37** Metrics count prepare chunks, commits, cleanup, redeems, downloads, entitlements and realtime failures; tokens, presigned URLs and bodies are never logged. [proof: S31 AS-73, S31 AS-74] [code: packages/backend/libs/domains/asset-library/application/asset-metrics.ts#assetMetrics]
- **S31.R-38** The capability reads and writes only its own tables, has no foreign key to another owner's table and reads other domains through their exported services and events. [proof: S31 AS-79] [code: packages/backend/db/ownership.ts#OWNERSHIP]
- **S31.R-39** The chunker is pure and content-defined: chunks concatenate to the input, stay within bounds, are deterministic, and one insertion changes at most 3 chunk hashes. [proof: S31 AS-77] [code: packages/backend/libs/domains/asset-library/domain/fastcdc.ts#chunk]

## Behaviors
- **S31.B-01** Given a file of six chunks, when the client prepares, uploads the missing chunks and commits with a key, then the answer is `201 created` at version 1 and a second prepare of the same chunks reports none missing. [proof: S31 AS-01, S31 AS-07]
- **S31.B-02** Given a committed 1 MiB file, when 20 bytes are inserted and the client prepares and commits again, then at most three chunks travel and version 2 downloads byte-identical. [proof: S31 AS-08]
- **S31.B-03** Given two devices that both edit version 1, when the second saves, then it becomes `/manual (conflicted copy phone-2 2026-10-05).txt` and both contents survive. [proof: S31 AS-21]
- **S31.B-04** Given a commit whose storage check is paused, when a test probes the chunk rows for a lock, then no lock is held. [proof: S31 AS-16]
- **S31.B-05** Given five changes after a cursor, when the journal is read with limit 2, then pages hold 2, 2 and 1 items and an empty page keeps the cursor. [proof: S31 AS-28]
- **S31.B-06** Given an asset with five versions, when the history is listed with limit 2, then pages hold 2, 2 and 1 versions, newest first. [proof: S31 AS-34]
- **S31.B-07** Given a deleted asset past 30 days, when the purge job runs twice at once, then its chunk references are released exactly once. [proof: S31 AS-40]
- **S31.B-08** Given a cleanup racing a commit of an old unreferenced chunk, when both run at once, then the commit answers `201` with the object present or `422 chunk_not_uploaded`. [proof: S31 AS-43]
- **S31.B-09** Given a link capped at 3 downloads, when ten redeems arrive at once, then three answer `200` and seven `410`. [proof: S31 AS-50]
- **S31.B-10** Given a redeemed link, when its download URL is fetched, then the file arrives byte-identical with the safe headers, and after 121 seconds the URL answers `410`. [proof: S31 AS-49, S31 AS-55]
- **S31.B-11** Given a product linked to a file, when `order.paid` arrives twice, then one entitlement and one event exist. [proof: S31 AS-61, S31 AS-62]
- **S31.B-12** Given an active entitlement and an outstanding buyer URL, when `order.refunded` arrives, then a new request answers `404` and the outstanding URL answers `410`. [proof: S31 AS-64]
- **S31.B-13** Given a buyer with an active entitlement, when they ask for a download, then they get a 600-second URL that serves the version pinned at issue time. [proof: S31 AS-67]
- **S31.B-14** Given a deleted shop, when `tenancy.shop_deleted` arrives, then its library is removed, its entitlements are revoked and another shop is untouched. [proof: S31 AS-71]

## Lifecycles
- Asset: `ACTIVE`, `DELETED`, `PURGED`; entitlement: `ACTIVE`, `REVOKED`. The asset moves only by conditional updates (delete, undelete, purge); the entitlement is terminal once revoked. The formal tables are the models `asset-status` and `entitlement-status`. [proof: S31 AS-38, S31 AS-39, S31 AS-64]

## Owns
- Tables: `Asset`, `AssetVersion`, `AssetVersionChunk`, `AssetChunk`, `AssetChange`, `AssetSyncState`, `AssetShopUsage`, `AssetShareLink`, `AssetDownloadGrant`, `DigitalProduct`, `AssetEntitlement`, `AssetOrderRevocation`. [code: packages/backend/db/ownership.ts#OWNERSHIP]
- Topic `assets.events`; realtime route `shop:<shopId>:assets`; jobs `assets.*`; rate-limit policies `assets.upload.shop`, `assets.redeem.ip`, `assets.grant.user`.
- Configuration: `usercontent_origin`, `assets_quota_bytes`, `assets_version_cap`, `assets_undelete_days`, `assets_journal_days`, `assets_gc_grace_hours`.

## Decisions
- Per-version chunk rows plus a counter keep "who references this chunk" an index lookup and the reference count verifiable.
- Cleanup claims a chunk, deletes the object, then the row, and a chunk reported stored is protected for 24 hours, so cleanup cannot race a commit into a missing object.
- Storage is checked before the transaction and re-validated inside it against protected chunk rows.
- The journal number comes from a locked counter row, so numbers are gapless and in commit order.
- Entitlements come from order events, not an order read, so a download never depends on the order service.
- Share and buyer downloads use opaque, version-pinned grants whose digest is stored and which are re-checked on every fetch.

## Known gaps
- The web screens (library browser, share dialog, share landing, "My purchases") and the sync client are owned by other capabilities.
- Entitlement latency (30 seconds at the 99th percentile), delta efficiency on a 1 GiB file, the 100-click share cap and streaming of 50 GiB files are not measured by automated tests; they are listed in `specs/UNVERIFIED.md`.
