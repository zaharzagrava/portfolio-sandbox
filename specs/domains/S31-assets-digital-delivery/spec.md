# Feature Specification: S31 — Shop Asset Library (Chunked Dedupe, Delta Sync, Conflicts, Share Links) and Digital Product Delivery (domain `asset-library`)

**Feature Branch**: `S31-assets-digital-delivery` (spec directory `specs/domains/S31-assets-digital-delivery`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S31 of `scripts/sdd/capabilities.tsv`. Sources: `docs/showcase/sections/SD-25-seller-media-library.md`, note `10-System-Design/08-media-and-files.md` (designs 25 file storage and sync, 27 large upload; the Interview-Prep copy of SD-25 does not exist, the repository copy is used). Pattern-map row covered: **P1113** (content-defined chunking, FastCDC). Patterns this capability also has to honour because its features sit on them: P0414 idempotency keys, P0415 cursor pagination, P0606 outbox and idempotent consumers, P0509 upload security, P0516 record-level security, P0610 consistency per feature, P0311 lost-update prevention.

## Scope

A shop keeps an **asset library** (brand kits, manuals, product files up to 50 GiB) that its team's devices keep in sync, and it can **sell a file as a digital product**. Files are split by a sync client into content-defined chunks. The platform stores each chunk once per shop, a file version is an ordered list of chunk hashes, and file bytes never pass through the application when they are uploaded. Devices ask what changed since a cursor, edit offline, and a stale save becomes a conflicted copy, never a lost update. A shop can hand out expiring, capped share links. After a buyer pays for a digital product, they can download the file through a short-lived link tied to them. A refund takes the access away.

In scope:

- **Chunked upload with dedupe and delta sync**: ask which chunks are missing, upload only those straight to storage with an integrity-checked permission, commit a version in one step; per-shop dedupe; storage quota; limits.
- **Versions and conflicts**: base-version check, conflicted copies, edit-versus-delete, unchanged saves, version history, restore, delete and undelete, retention.
- **Change journal and reads**: per-shop gapless journal read by cursor, listing, manifests for chunk downloads, a realtime "something changed" notification.
- **Garbage collection** of chunks nobody references, reference counting, grace period, and its races with upload and commit.
- **Share links**: create, list, revoke, preview, redeem with an atomic expiry and download cap; the download itself.
- **Digital product delivery**: link a file to a product, grant an entitlement from the paid-order event, revoke it on refund, the buyer's purchases list and download links, reactions to product and shop deletion.
- **Cross-cutting**: authorization and tenant isolation, rate limits, observability, jobs, events, ownership of data.

Out of scope (owners named):

- Product photos and review photos (`media`) → **S29**; video, transcoding and HLS → **S30**. They share the object-storage port and the user-content origin convention, not data.
- Product records, prices and stock → **S05**. Orders, payment results and refunds → **S10**, **S13**. Shop roles and offboarding → **S03**. Mails and notifications about a download → **S28**. Realtime hub → **S51**. Outbox, inbox, consumers → **S53**. Jobs → **S49**. Rate limiter → **S50**. Platform toolkit (problem+json, idempotency facility, clock, metrics, config) → **S54**. Authentication → **S01**. Plans and per-plan quotas → **S18** (a fixed default quota applies until S18 asks for more).
- The desktop and mobile sync client, the web screens (library browser, share dialog, share landing page, "My purchases") → the web capabilities. No web capability owns them yet (see `questions.md`). The client's chunking function (FastCDC) is specified here as pure logic because the tests and the CLI play the client.
- Per-folder permissions and inheritance (shop roles apply to the whole library), renames and moves (a client expresses them as delete plus create, which uploads zero bytes because the chunks already exist), real watermarking of files (only the hook and the licensee tag), resumable browser downloads (sync clients resume per chunk), cross-shop dedupe (refused on purpose), antivirus scanning of library files (the library is a private shop workspace; digital product files are the seller's responsibility, see Assumptions).

## User Scenarios & Testing *(mandatory)*

Notation: `S1`, `S2` are shops; `U1` is an `OWNER`, `U2` a `VIEWER`, `U3` a user who is a member of `S2` only; `B` a buyer; `P` a product of `S1`; `A` an asset; sizes are bytes; "the client" is the test code that plays the sync client (it chunks with the exported pure chunker, calls prepare, puts bytes to the issued URLs, commits). "Time is frozen" means tests control the clock. Test chunking parameters are 4 KiB / 16 KiB / 64 KiB; production parameters are 1 MiB / 4 MiB / 16 MiB. Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code`. Every response body parses with its schema in `packages/contracts`. Money does not appear in this capability.

### User Story 1 — A team syncs a big file and re-uploads only what changed (Priority: P1)

A designer saves a 1 GiB brand kit. The client asks which chunks the platform lacks, uploads only those directly to storage, and commits a version. Later they edit the middle; only the chunks around the edit travel. A retried commit never creates a second version, a half-failed upload never leaves a version with missing bytes, and one shop can never learn that another shop holds the same bytes.

**Why this priority**: it is the capability's reason to exist and the cost driver (bandwidth and storage).

**Independent Test**: chunk real random bytes, prepare, put to the issued permissions in real object storage, commit, edit, repeat; count uploaded chunks, read back byte-identical content, assert refcounts, journal and persisted rows.

**Acceptance Scenarios**:

1. **AS-01** (prepare returns only what is missing) — **Given** shop `S1` and a file of 6 chunks `c1..c6`, **When** `POST /shops/S1/assets/prepare {chunks: [{hash, size} × 6]}` (as `U1`), **Then** `200 {missing: [6 × {hash, url, headers, expiresAt}], alreadyStored: 0}` where each permission is valid 900 seconds from now and names exactly that hash and size; **When** the client uploads all six, commits, and prepares the same six again, **Then** `200 {missing: [], alreadyStored: 6}`.
2. **AS-02** (dedupe inside a call, across files, and never across shops) — **Given** a request that lists `c1` twice and `c2` once, **Then** `missing` has two entries (the duplicate collapses) and `alreadyStored` counts distinct chunks; **Given** file `/x` committed with `c1..c3`, **When** `/y` is prepared with `c2, c3, c7`, **Then** only `c7` is missing; **Given** shop `S2` prepares the same hashes `c1..c3` that only `S1` holds, **Then** all three are `missing` for `S2` with its own storage keys, the response is indistinguishable from preparing unknown hashes, and `S1`'s rows are untouched.
3. **AS-03** (prepare validation) — **Given** bodies with: a hash of 63 or 65 characters, upper-case hex, non-hex; `size` `0`, `-1`, `1.5`, `"10"`, 16 MiB + 1; an empty `chunks`; 5,001 chunks; an unknown property; no body, **When** each is sent, **Then** each answers `400 validation_failed` naming the failing field, and nothing is persisted; exactly 5,000 chunks and a size of exactly 16 MiB answer `200`.
4. **AS-04** (one hash, one size) — **Given** `S1` holds chunk `c1` of size 4,096, **When** prepare lists `c1` with size 5,000, **Then** `422 chunk_size_mismatch {hash}` and nothing changes.
5. **AS-05** (stored means confirmed in storage) — **Given** a prepare for `c9` and the client never uploads it, **When** the same prepare is repeated 10 minutes and again 3 hours later, **Then** `c9` is `missing` again each time with a fresh permission and `alreadyStored` does not count it; **Given** the bytes of `c9` are then uploaded, **Then** the next prepare counts it as stored.
6. **AS-06** (integrity) — **Given** a permission issued for hash `h` and size `n`, **When** the client puts bytes that do not hash to `h`, or whose length is not `n`, **Then** storage refuses the upload (4xx) and a commit that lists `h` answers `422 chunk_not_uploaded {hashes: [h]}`; **When** the correct bytes are put, **Then** storage accepts and the commit succeeds; a permission whose 900 seconds passed is refused by storage.
7. **AS-07** (commit creates the first version) — **Given** the chunks of AS-01 are stored, **When** `POST /shops/S1/assets/commit {path: "/kits/brand-guide.pdf", baseVersion: 0, chunks: [c1..c6], sizeBytes, deviceId: "laptop-1"}` with `Idempotency-Key: K1`, **Then** `201 {assetId, path, version: 1, outcome: "created", conflicted: false, sizeBytes}`; persisted: one `ACTIVE` asset at that path, one version row with the ordered hashes, `createdBy = U1`, each chunk's reference count `1`, and one journal entry `{seq: 1, kind: "upsert", version: 1}`; and the library's change notification fires once (AS-33).
8. **AS-08** (delta sync) — **Given** a committed 1 MiB random file of ~64 chunks, **When** 20 bytes are inserted at offset 600,000 and the client prepares and commits again with `baseVersion: 1`, **Then** `201 {version: 2, outcome: "updated", conflicted: false}`, prepare reported at most 3 chunks missing, the shared chunks have reference count `2` and the new ones `1`, downloading version 2 through the manifest (AS-32) is byte-identical to the edited file, and the journal holds seq 1 and 2.
9. **AS-09** (commit validation) — **Given** bodies with a `path` that: has no leading slash, contains `//`, a `.` or `..` segment, ends with `/`, contains a NUL, a backslash or a control character, is longer than 1,000 characters, or has a segment longer than 255 characters; `chunks` with 15,001 entries, an upper-case or short hash; `sizeBytes` negative, fractional or above 50 GiB (53,687,091,200); `baseVersion` negative or fractional; a `deviceId` outside `[A-Za-z0-9_-]{4,64}`; an unknown property, **When** each is sent, **Then** each answers `400 validation_failed` and nothing is persisted; **When** the `Idempotency-Key` header is missing, shorter than 8, longer than 128 characters or contains a space, **Then** `422 idempotency_key_required` or `422 idempotency_key_invalid`; exactly 15,000 chunks and exactly 50 GiB pass validation.
10. **AS-10** (commit refuses what it cannot prove) — **Given** a commit that lists: a hash never prepared; a hash prepared but never uploaded; a hash that only `S2` holds; sizes that do not add up to `sizeBytes`, **Then** respectively `422 chunks_unknown {hashes}`, `422 chunk_not_uploaded {hashes}`, `422 chunks_unknown {hashes}`, `422 size_mismatch {expectedBytes, actualBytes}`; in every case no asset, version, reference count or journal row changes.
11. **AS-11** (empty file) — **Given** `chunks: []` and `sizeBytes: 0`, **When** committing `/.gitkeep`, **Then** `201 {version: 1, outcome: "created", sizeBytes: 0}`, the manifest has zero chunks, and a download delivers zero bytes; `chunks: []` with `sizeBytes: 5` answers `422 size_mismatch`.
12. **AS-12** (idempotent commit) — **Given** a successful commit with key `K1`, **When** the same body and key are sent again, **Then** the stored `201` body is returned with `Idempotency-Replayed: true`, and exactly one version exists (not a conflicted copy of itself); **Given** a commit paused in its storage check (a test gate), **When** the same key and body arrive, **Then** `409 idempotency_in_flight` with `Retry-After: 1`; **When** key `K1` is sent with a different body, **Then** `422 idempotency_key_reuse` and nothing changes; the same key used in another shop or by another user is independent; keys expire after 24 hours (time advanced).
13. **AS-13** (a save that changes nothing) — **Given** `/a.txt` at version 3 with chunk list `L`, **When** a commit sends `baseVersion: 3` and the same list `L`, **Then** `200 {version: 3, outcome: "unchanged"}`, no version, reference count, journal entry or notification is added.
14. **AS-14** (storage quota) — **Given** a shop whose stored plus reserved bytes equal its quota minus 1,000, **When** it prepares chunks whose new bytes total 2,000, **Then** `409 quota_exceeded {limitBytes, usedBytes}` and nothing is reserved; **When** it prepares only chunks it already holds (no new bytes), **Then** `200`; **When** a version is deleted and the garbage collector frees its chunks, **Then** the same prepare succeeds. The quota is 100 GiB per shop unless configured otherwise.
15. **AS-15** (quota under concurrency) — **Given** a shop with 10 MiB of quota left and two prepares of 6 MiB of distinct new chunks, **When** both run at once (`Promise.all`), **Then** exactly one answers `200` and the other `409 quota_exceeded`, and stored plus reserved bytes never exceed the quota.
16. **AS-16** (no storage call inside a database transaction) — **Given** a commit whose storage existence check is paused by a test gate, **When** a test probes the same chunk records for a row lock without waiting during the pause, **Then** the probe succeeds (no lock is held while storage is called); **When** the gate opens, **Then** the commit answers `201`.
17. **AS-17** (storage unavailable at commit) — **Given** storage fails or times out (5 seconds) on the existence check, **When** committing, **Then** `503 storage_unavailable` with `Retry-After`, a generic `detail`, nothing persisted and a failure counted; **When** storage recovers and the same request (same key) is repeated, **Then** `201`.
18. **AS-18** (upload rate limit) — **Given** shop `S1` that already made 120 `prepare` plus `commit` calls in the last minute, **When** the 121st arrives, **Then** `429 rate_limited` with `Retry-After` and nothing is written; shop `S2` is unaffected; reads are not limited by this policy.
19. **AS-19** (who may do what) — **Given** no credentials, a `VIEWER` (`U2`), an `OWNER` (`U1`), **When** each calls every shop-scoped endpoint of this capability (table-driven), **Then** no credentials → `401`; `VIEWER` → `2xx` on reads (`products.read`) and `403 permission_denied` on every write (`products.write`); `OWNER` → `2xx`; a suspended or offboarding shop follows tenancy's status gate (`403 shop_suspended`, `409 shop_offboarding`).
20. **AS-20** (cross-tenant access) — **Given** `U3` (member of `S2` only) and `U1`, **When** `U3` calls any `/shops/S1/…` route, **Then** `404 shop_not_found` (existence hidden); **When** `U3` calls `/shops/S2/assets/<A of S1>/…` for every asset-ID route (manifest, versions, delete, restore, undelete, share, share links, link to a product), **Then** `404 asset_not_found` and no state changes; **When** `U3` links `S1`'s asset or product through `/shops/S2/products/<P of S1>/digital-asset/<A of S1>`, **Then** `404`.

---

### User Story 2 — Two devices edit the same file and nothing is lost (Priority: P1)

A laptop and a phone both edit the manual while offline. The first save wins the main file, the second becomes a clearly named conflicted copy beside it. Devices learn about all of this by asking "what changed since my cursor", in strict order, and download only the chunks they lack.

**Why this priority**: lost updates in a sync product are data loss; the journal is how every device converges.

**Independent Test**: commit from two simulated devices with the same base (sequentially and with `Promise.all`), read the journal and list, download both files.

**Acceptance Scenarios**:

1. **AS-21** (stale save becomes a conflicted copy) — **Given** `/manual.txt` at version 1 and device `laptop-1` committing `baseVersion: 1` → version 2, **When** device `phone-2` commits different content with `baseVersion: 1` on `2026-10-05`, **Then** `201 {outcome: "conflicted_copy", conflicted: true, path: "/manual (conflicted copy phone-2 2026-10-05).txt", version: 1}` with a new `assetId`; `/manual.txt` stays at version 2 with the laptop's content; both contents download byte-identical; the journal gains one `upsert` for the copy.
2. **AS-22** (copies never overwrite copies) — **Given** the copy of AS-21 exists, **When** `phone-2` produces a second conflict the same day, **Then** the path is `/manual (conflicted copy phone-2 2026-10-05) (2).txt`, then `(3)` for a third; the first copy's content and version are untouched.
3. **AS-23** (conflict naming, pure) — **Given** the naming function over `(path, deviceId, date, takenPaths)`, **When** table-driven over: `/a.txt`, `/a`, `/.env` (a dot file has no extension), `/v1.2/readme` (a dot in a directory is not an extension), `/a.tar.gz` (only the last extension), a taken name, a taken name with `(2)` also taken, a date at `23:59:59Z` and one at `00:00:00Z` the next day, **Then** results are exactly `/a (conflicted copy D 2026-10-05).txt`, `/a (conflicted copy D 2026-10-05)`, `/.env (conflicted copy D 2026-10-05)`, `/v1.2/readme (conflicted copy D 2026-10-05)`, `/a.tar (conflicted copy D 2026-10-05).gz`, `… ) (2).…`, `… ) (3).…`, and the date is the UTC date of the injected clock.
4. **AS-24** (concurrent saves, one winner) — **Given** `/m.txt` at version 1, **When** two devices commit with `baseVersion: 1` at once (`Promise.all`), **Then** exactly one answers `outcome: "updated"` (version 2) and the other `outcome: "conflicted_copy"`; the original has versions `[1, 2]` and the copy `[1]`; seq values in the journal are consecutive; no content is lost.
5. **AS-25** (creating a file that already exists) — **Given** `/m.txt` exists at version 2, **When** a device commits it with `baseVersion: 0`, **Then** the result is a conflicted copy (the device did not know the file).
6. **AS-26** (edit versus delete) — **Given** device A deleted `/m.txt` (AS-38) and device B, still at version 2, commits `/m.txt` with `baseVersion: 2`, **Then** `201 {outcome: "created", conflicted: false, version: 1}` with a new `assetId` at the original path (the edit wins over the delete, nothing is lost); the deleted asset stays deleted.
7. **AS-27** (a base from the future) — **Given** `/m.txt` live at version 2, **When** a commit sends `baseVersion: 5`, **Then** `422 invalid_base_version {currentVersion: 2}` and nothing changes.
8. **AS-28** (reading the journal) — **Given** five committed changes after the cursor `C` that `GET /shops/S1/assets` returned as `syncCursor`, **When** `GET /shops/S1/assets/changes?cursor=C&limit=2` is called three times following `nextCursor`, **Then** pages hold `{items: [{seq, assetId, path, version, kind: "upsert" | "delete"}], nextCursor, hasMore}` with 2, 2, 1 items in ascending `seq`, each change once, `hasMore` true, true, false; **When** called again with the last `nextCursor`, **Then** `items: []` and the same `nextCursor`.
9. **AS-29** (journal order under concurrency) — **Given** 20 commits to 20 different paths at once, **Then** the journal holds sequence numbers `n+1 … n+20` each exactly once with no gap, and reading in order never shows a later number before an earlier one is committed.
10. **AS-30** (cursor misuse) — **Given** no `cursor`, a malformed `cursor`, a cursor beyond the newest change, `limit` `0` and `1001`, **Then** `400 validation_failed`, `422 invalid_cursor`, `422 invalid_cursor`, `400 validation_failed`, `400 validation_failed`; **Given** a cursor older than the oldest retained journal entry (AS-76), **Then** `410 cursor_expired` and the client lists the library again.
11. **AS-31** (listing the library) — **Given** 7 live assets, one deleted asset and assets of another shop, **When** `GET /shops/S1/assets?limit=3` is followed through `nextCursor`, **Then** pages of 3, 3, 1 in ascending path order with ties broken by ID, each asset once, no foreign or deleted asset, every first page carrying `syncCursor` (the newest change number read before listing); `?prefix=/kits/` returns only that subtree and treats `%` and `_` literally; `?deleted=true` lists only deleted assets within the undelete window; `limit` `0` or `101` → `400 validation_failed`.
12. **AS-32** (manifest and parallel chunk download) — **Given** a version of 5 chunks, **When** `GET /shops/S1/assets/A/manifest?version=2&from=0&limit=2` is followed through `nextFrom`, **Then** each page lists `{index, hash, sizeBytes, url}` in file order with a download URL valid 600 seconds and `totalChunks: 5`; fetching every URL and concatenating gives the file byte-identically; omitting `version` serves the current version; an unknown version → `404 version_not_found`; a deleted asset → `404 asset_not_found`; `limit` above 2,000 → `400 validation_failed`.
13. **AS-33** (change notification) — **Given** a subscriber on the shop's asset topic, **When** a commit with outcome `created`, `updated`, `conflicted_copy`, a delete, an undelete or a restore succeeds, **Then** exactly one `assets.changed {lastSeq}` is published after the commit; an `unchanged` commit publishes nothing; **Given** the hub is down (forced), **Then** the commit still succeeds, no event is lost from the journal and a failure is counted.

---

### User Story 3 — History, deletion and cleanup that never destroy live bytes (Priority: P2)

Versions can be listed and restored, files can be deleted and brought back, and storage is reclaimed only for chunks no version needs, with a grace period, even when upload, commit and cleanup race.

**Why this priority**: it is what makes the library trustworthy to delete from, and storage cost control.

**Independent Test**: build versions that share chunks, delete in each order, age chunks with the controlled clock, run cleanup (also concurrently with commits), assert reference counts and objects in storage.

**Acceptance Scenarios**:

1. **AS-34** (version history) — **Given** an asset with 5 versions, **When** `GET /shops/S1/assets/A/versions?limit=2` is followed through `nextCursor`, **Then** pages list `{version, sizeBytes, chunkCount, createdBy, deviceId, createdAt}` newest first (2, 2, 1), without chunk hashes; another shop's asset → `404`.
2. **AS-35** (delete an old version) — **Given** versions 1 and 2 sharing most chunks and version 2 current, **When** `DELETE /shops/S1/assets/A/versions/1`, **Then** `204`, version 1 is gone, shared chunks keep reference count 1, chunks only version 1 used drop to 0 and start their grace period, version 2 still downloads, and no journal entry is added.
3. **AS-36** (illegal version deletes) — **Given** the same asset, **When** deleting version 2 (the current one), **Then** `409 cannot_delete_current_version`; **Given** an asset with only version 1, **Then** the same `409`; **Given** an unknown or already deleted version number, **Then** `404 version_not_found`; nothing changes in any case.
4. **AS-37** (restore an old version) — **Given** versions 1..3 and version 3 current, **When** `POST /shops/S1/assets/A/versions/1/restore {baseVersion: 3}`, **Then** `201 {version: 4, outcome: "updated"}` whose chunk list equals version 1's, no bytes are uploaded, reference counts of its chunks rise by their occurrences, one `upsert` is journaled; **When** `baseVersion` is `2`, **Then** the result is a conflicted copy as in AS-21; on a deleted asset `409 asset_deleted`.
5. **AS-38** (delete a file) — **Given** a live asset `A` with a share link, **When** `DELETE /shops/S1/assets/A`, **Then** `204`, status `DELETED` with `deletedAt`, one journal entry `{kind: "delete", version: <current>}`, the path is free for a new asset, versions and chunks stay (restorable), the share link answers `410` (AS-53); a second delete → `409 invalid_transition`; **Given** the asset is linked to a digital product or referenced by an entitlement, **Then** `409 asset_in_use` and nothing changes.
6. **AS-39** (undelete) — **Given** a deleted asset within 30 days, **When** `POST /shops/S1/assets/A/undelete`, **Then** `200` with status `ACTIVE` and one `upsert` journaled; **Given** another live asset now owns the path, **Then** `409 path_taken`; **Given** an `ACTIVE` asset, **Then** `409 invalid_transition`; **Given** a purged asset, **Then** `404 asset_not_found`.
7. **AS-40** (retention purge) — **Given** a deleted asset and time frozen at its `deletedAt + 30 days − 1 second`, **When** the purge job runs, **Then** it stays; at `+ 30 days + 1 second` the job removes its versions, releases each version's chunk references exactly once and removes its share links; running the job twice, or two runs at once, never releases twice and no reference count is ever negative.
8. **AS-41** (cleanup grace and deletion) — **Given** chunks with reference count 0 unreferenced for 23 h 59 min, 24 h 00 min 01 s, and a chunk with reference count 1 unreferenced for 10 days (a stale marker), **When** cleanup runs, **Then** only the second is removed (its storage object first, then its row); **Given** storage refuses the object delete (forced), **Then** the row is kept, the failure is counted, and the next run retries and succeeds.
9. **AS-42** (reuse restarts the grace) — **Given** an unreferenced chunk `c` whose object still exists, unreferenced for 25 hours, **When** a prepare lists `c`, **Then** it is reported `alreadyStored`; **When** cleanup runs immediately, **Then** `c` survives and its grace restarts; **When** the client commits a version that uses `c`, **Then** `201` and the download is byte-identical.
10. **AS-43** (cleanup racing a commit) — **Given** an unreferenced chunk `c` older than the grace period and a commit that lists `c`, **When** cleanup and the commit run at once (`Promise.all`), **Then** either the commit answers `201` and `c`'s object exists, or it answers `422 chunk_not_uploaded` (the client prepares again); in no outcome does a committed version reference a missing object (checked by reading every chunk of every version).
11. **AS-44** (reference counts stay exact) — **Given** 10 files committed at once that all contain chunk `c`, one of them listing `c` twice, **Then** `c`'s reference count equals the number of occurrences across all versions (11); deleting versions and assets in any order brings it back to 0 exactly, never below, and `c` becomes collectable only then.
12. **AS-45** (version cap) — **Given** an asset with 500 versions, **When** a commit would create version 501, **Then** `409 version_limit_reached {limit: 500}` and nothing changes; **When** an old version is deleted, **Then** the commit succeeds.

---

### User Story 4 — A shop shares a file by link, with expiry and a download cap (Priority: P1)

A seller sends a press kit to a journalist. The link expires, can be capped to N downloads, can be revoked, and cannot be used after the file is deleted. Hundreds of simultaneous clicks never exceed the cap, link scanners that merely open the link never burn a download, and the file is served so that it can never run as part of the platform's own site.

**Why this priority**: it is an outbound, anonymous, internet-facing surface.

**Independent Test**: create links with each limit, redeem sequentially and with `Promise.all`, advance the clock past each boundary, inspect headers and stored rows (token never stored).

**Acceptance Scenarios**:

1. **AS-46** (create and list) — **Given** `U1` and a live asset `A`, **When** `POST /shops/S1/assets/A/share {expiresInHours: 24, maxDownloads: 3}`, **Then** `201 {id, token, url, expiresAt, maxDownloads: 3, createdAt}` with a token of at least 192 bits (32+ base64url characters), `url = <user-content origin>/assets/shared/<token>` on an origin different from the application's own origin, and persisted only the token's digest, never the token; `GET /shops/S1/assets/A/share-links` lists links with `{id, expiresAt, maxDownloads, downloads, status: "ACTIVE" | "EXPIRED" | "EXHAUSTED" | "REVOKED", createdBy}` and never a token; another shop's asset → `404`; a deleted asset → `404 asset_not_found`.
2. **AS-47** (share limits) — **Given** `expiresInHours` `0`, `721`, `1.5`, `"24"`, missing; `maxDownloads` `0`, `10001`, `1.5`, `"3"`, **Then** each answers `400 validation_failed`; `expiresInHours: 720` and `maxDownloads: 10000` and an omitted `maxDownloads` (unlimited) answer `201`.
3. **AS-48** (preview never counts) — **Given** a valid link, **When** `GET /assets/shared/<token>` (no credentials) is called 5 times, **Then** each answers `200 {fileName, sizeBytes, expiresAt, remainingDownloads: 3 | null}` and `downloads` stays 0; for an unknown token, an expired, revoked, exhausted link or a deleted asset the answer is the identical `410 link_unavailable` body.
4. **AS-49** (redeem, then download) — **Given** a valid link, **When** `POST /assets/shared/<token>/redeem` (no credentials), **Then** `200 {url, expiresAt, fileName, sizeBytes}` with a download URL valid 120 seconds and `downloads` becomes 1; **When** `GET <url>` is called, **Then** `200` with the file byte-identical and the headers of AS-55; calling the same URL again within the 120 seconds also answers `200` and does not change `downloads`; **When** 121 seconds pass, **Then** `410 download_unavailable`.
5. **AS-50** (the cap holds under a crowd) — **Given** a link with `maxDownloads: 3`, **When** 10 redeems arrive at once (`Promise.all`), **Then** exactly 3 answer `200` and 7 answer `410 link_unavailable`, `downloads` is 3, and a later redeem answers `410`.
6. **AS-51** (expiry boundary) — **Given** a link with `expiresAt = T` and time frozen, **When** redeeming at `T − 1 s`, **Then** `200`; at exactly `T`, **Then** `410 link_unavailable`; previews follow the same rule.
7. **AS-52** (revoke) — **Given** a link and an outstanding download URL from it, **When** `DELETE /shops/S1/assets/A/share-links/<id>`, **Then** `204`, the link's status is `REVOKED`, a new redeem answers `410`, and the outstanding URL answers `410 download_unavailable`; a second revoke → `409 invalid_transition`; another shop's link ID → `404 share_link_not_found`.
8. **AS-53** (deleted file) — **Given** a link on a live asset, **When** the asset is deleted, **Then** preview and redeem answer `410 link_unavailable` and the redeem does not count; **When** it is undeleted within its window, **Then** the link works again until its expiry.
9. **AS-54** (a link serves the latest version) — **Given** a link created when the asset was at version 1 and a commit to version 2, **When** the link is redeemed, **Then** the download is version 2's content; a later commit does not change a download URL already issued (it serves the version it was issued for).
10. **AS-55** (safe delivery headers) — **Given** any share or buyer download of a file named `/promo/pic.svg`, **When** the URL is fetched, **Then** the response has `Content-Type: application/octet-stream`, `Content-Length` equal to the file size, `Content-Disposition: attachment` with both an ASCII `filename` and an RFC 6266 `filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, and no `Set-Cookie`.
11. **AS-56** (attachment file names, pure) — **Given** the header-building function, **When** table-driven over: `résumé "v2".pdf`, a name with `\r\n` and `Set-Cookie:` inside, a name with `;`, `\` and `%`, a 400-character name, a name of only control characters, an empty name, **Then** the result never contains a raw CR, LF, unescaped quote or non-ASCII byte in `filename`, `filename*` carries the UTF-8 percent-encoded original (control characters removed), a long name is cut to 255 bytes without splitting a character, and an empty or all-control name becomes `download`.
12. **AS-57** (storage fails while streaming) — **Given** a download whose first chunk cannot be opened (forced), **Then** `503 storage_unavailable` before any file byte or download header is sent; **Given** a later chunk fails mid-stream, **Then** the connection is aborted so the client sees fewer bytes than `Content-Length`, a failed-download metric is counted, and no stack trace or storage message reaches the client.
13. **AS-58** (anonymous rate limit) — **Given** one client address that already made 60 preview, redeem and download calls in the last minute, **When** the 61st arrives, **Then** `429 rate_limited` with `Retry-After`, `downloads` is not changed; another address is unaffected.

---

### User Story 5 — A buyer pays for a digital product and downloads it; a refund takes it away (Priority: P1)

A seller attaches a file to a product. When an order containing it is paid, the buyer gets the right to download it (within seconds, without the order service being asked). The buyer's "My purchases" lists it and each click issues a ten-minute link only they were given. A refund ends the right. Nobody else, not even the seller's team, can get a buyer's download.

**Why this priority**: it is money-adjacent and the product's core value for digital sellers.

**Independent Test**: link an asset to a product, deliver contract-valid `order.paid` and `order.refunded` messages (twice, out of order, malformed), then drive the buyer HTTP calls; assert entitlement rows, outbox rows and every unavailable branch.

**Acceptance Scenarios**:

1. **AS-59** (link a file to a product) — **Given** `U1`, product `P` of `S1` and a live asset `A` of `S1`, **When** `PUT /shops/S1/products/P/digital-asset/A`, **Then** `204`, `GET /shops/S1/products/P/digital-asset` answers `200 {productId, assetId, fileName, sizeBytes, version, linkedAt}`, and `assets.digital_product_linked` is in the outbox; **When** the same `PUT` is repeated, **Then** `204` and no second event; **Given** a product of another shop, an unknown product (the product-lookup service says so), an asset of another shop or a deleted asset, **Then** `404 product_not_found` or `404 asset_not_found` and no row; a `VIEWER` → `403`.
2. **AS-60** (re-link and unlink) — **Given** `P` linked to `A` with active entitlements, **When** `PUT … /digital-asset/A2` (another live asset of `S1`), **Then** `204` and every active entitlement of `P` now delivers `A2` (one transaction); **When** `DELETE /shops/S1/products/P/digital-asset`, **Then** `409 digital_product_sold` while any entitlement exists; **Given** no entitlement exists, **Then** `204` and `assets.digital_product_unlinked` is in the outbox; unlinking an unlinked product → `404 digital_link_not_found`.
3. **AS-61** (grant on payment) — **Given** `P` linked to `A`, non-digital product `Q`, and the message `order.paid {orderId: O, userId: B, orderVersion: 3, lines: [{productId: P, shopId: S1, title: "E-book", quantity: 3, …}, {productId: Q, …}]}`, **When** it is delivered, **Then** exactly one entitlement exists for `(O, P, B)` with the title snapshot and `status: ACTIVE`, none for `Q`, quantity `3` makes no second one, and `assets.entitlement_granted {entitlementId, orderId, productId, shopId, buyerId, grantedAt}` is in the outbox.
4. **AS-62** (duplicate delivery) — **Given** the message of AS-61, **When** it is delivered twice in sequence and twice at once (`Promise.all`), **Then** one entitlement and one event exist.
5. **AS-63** (invalid or foreign messages) — **Given** payloads missing `userId`, with `lines` not an array, an unknown `version`, `orderVersion` `0`, a line whose `shopId` differs from the product's link shop, **When** delivered, **Then** the malformed ones are rejected and dead-lettered with no rows and no event; the foreign-shop line is ignored (one shop's order line can never grant another shop's file); processing continues with the next message.
6. **AS-64** (refund revokes) — **Given** an entitlement from AS-61 and an outstanding buyer download URL, **When** `order.refunded {orderId: O, userId: B, orderVersion: 5, …}` is delivered (twice), **Then** the entitlement is `REVOKED` with reason `refunded`, `assets.entitlement_revoked {entitlementId, orderId, productId, shopId, buyerId, reason, revokedAt}` is in the outbox once, a new download request answers `404 entitlement_not_found`, and the outstanding URL answers `410 download_unavailable`; the purchases list (AS-66) no longer shows it.
7. **AS-65** (events out of order) — **Given** `order.refunded {orderVersion: 5}` delivered before `order.paid {orderVersion: 3}`, **Then** the later `order.paid` creates no entitlement (the order's revocation was recorded); **Given** a replay of `order.paid {orderVersion: 3}` after a refund of version 5, **Then** no entitlement is re-created; **Given** a `order.paid` for an order with no refund, **Then** it grants as in AS-61.
8. **AS-66** (My purchases) — **Given** buyer `B` with 3 active entitlements and one revoked, and another buyer `C` with one, **When** `GET /me/purchases?limit=2` is followed through `nextCursor`, **Then** `B` sees pages of 2 and 1, newest grant first with a tiebreaker, items `{entitlementId, productId, shopId, orderId, title, fileName, sizeBytes, grantedAt}`, and never `C`'s or the revoked one; `limit` `0` or `101` → `400`; no credentials → `401`.
9. **AS-67** (download for a buyer) — **Given** `B` with an active entitlement for `P`, **When** `POST /me/purchases/P/download`, **Then** `200 {url, expiresAt, expiresInSec: 600}`, the entitlement's `downloadCount` rises by 1 and `lastDownloadAt` is set; **When** `GET <url>` (no credentials needed, the URL is the credential) is called, **Then** `200` with the file byte-identical, the headers of AS-55 and `X-Licensed-To: B`; **Given** the seller commits version 2 after the URL was issued, **Then** that URL still serves version 1 and the next request serves version 2.
10. **AS-68** (not yours) — **Given** a user `D` who did not buy `P`, a shop member of `S1`, and an unknown product ID, **When** each calls `POST /me/purchases/<product>/download`, **Then** all answer the identical `404 entitlement_not_found`; no credentials → `401`; a revoked entitlement → the same `404`.
11. **AS-69** (a download URL is short and uniform) — **Given** a buyer URL, **When** fetched at `expiresAt − 1 s` and at `expiresAt` (time advanced), **Then** `200` and `410 download_unavailable`; a URL with one character changed, a truncated URL, an empty token, a share URL used on the buyer route and the reverse, and a URL for a deleted-and-purged asset all answer the identical `410 download_unavailable` body.
12. **AS-70** (product deleted) — **Given** `catalog.product_deleted {productId: P, shopId: S1, productVersion}` (delivered twice), **Then** the link is removed once and `assets.digital_product_unlinked` is published once, existing entitlements stay `ACTIVE` and still download; an invalid payload is dead-lettered.
13. **AS-71** (shop deleted) — **Given** `tenancy.shop_deleted {shopId: S1}` (delivered twice) and a second shop `S2` with data, **Then** all of `S1`'s assets, versions, links, share links, grants and journal are removed, its chunk objects are removed by the cleanup path, its entitlements are `REVOKED` with reason `shop_deleted` (one `assets.entitlement_revoked` each), `S2` is untouched, and the second delivery changes nothing; an invalid payload is dead-lettered.
14. **AS-72** (grant rate limit) — **Given** buyer `B` who already requested 30 download links in the last minute, **When** the 31st arrives, **Then** `429 rate_limited` with `Retry-After` and no grant or counter change; another buyer is unaffected.

---

### User Story 6 — Operators can see it work and trust the background jobs (Priority: P2)

Metrics and logs show uploads, dedupe, conflicts, cleanup and deliveries without leaking secrets; scheduled jobs run once per schedule and are safe to repeat; the journal and expired grants are pruned.

**Why this priority**: a storage service without cleanup and visibility is a cost and incident risk.

**Independent Test**: run flows, read the metric registry and captured logs; run each job twice and concurrently.

**Acceptance Scenarios**:

1. **AS-73** (metrics) — **Given** the flows above, **Then** the metric registry holds counters `assets_prepare_chunks_total{result="missing"|"stored"}`, `assets_commit_total{outcome="created"|"updated"|"conflicted_copy"|"unchanged"|"rejected"}`, `assets_gc_deleted_total`, `assets_gc_failures_total`, `assets_share_redeem_total{outcome="ok"|"unavailable"|"limited"}`, `assets_download_total{kind="share"|"purchase",outcome="ok"|"unavailable"|"aborted"}`, `assets_entitlement_total{event="granted"|"revoked"|"ignored"|"dead_lettered"}`, `assets_realtime_publish_failures_total`, a gauge `assets_storage_bytes` per shop tier (bounded labels), and a histogram of event-to-entitlement lag; each increments exactly as the scenarios above describe (spot-checked in AS-01, AS-12, AS-21, AS-41, AS-49, AS-57, AS-61).
2. **AS-74** (secrets stay out of logs) — **Given** a share creation, preview, redeem, download and buyer download with captured logs, **Then** no log line contains a share token, a download token, a presigned URL query string or a request body; request logs record the route template (`/assets/shared/:token`) and carry `requestId`.
3. **AS-75** (jobs run once, safely) — **Given** the jobs `assets.gc-chunks` (hourly), `assets.purge-deleted-assets`, `assets.purge-download-grants` (expired grants), `assets.purge-changes` (daily), **When** each is triggered twice at once, **Then** one run does the work and the other does nothing or skips, a chunk is deleted once, counts add up, and a repeated run changes nothing.
4. **AS-76** (journal retention) — **Given** journal entries aged 91 days and 89 days, **When** `assets.purge-changes` runs, **Then** only the 91-day entries are removed, the oldest retained position is recorded, and a cursor older than it answers `410 cursor_expired` (AS-30) while a current cursor still works.
5. **AS-77** (chunker, pure) — **Given** the content-defined chunker with test and production parameters, **When** table-driven and property-checked (`fast-check` over random byte arrays and insert positions), **Then** concatenating the chunks reproduces the input; every chunk except the last is within `[min, max]`; the last is at most `max`; an empty input yields no chunks; boundaries are identical for identical input (deterministic across runs); a single insertion changes at most 3 chunk hashes; the mean size is within 0.6–1.6 × `avg`; an input shorter than `min` is one chunk.
6. **AS-78** (path rules, pure) — **Given** the path validation and normalization function, **When** table-driven over valid and invalid paths of AS-09 plus Unicode composed and decomposed forms of the same name, **Then** invalid paths are rejected with the specific reason, valid ones are returned in NFC form, a segment longer than 255 characters or a path longer than 1,000 is rejected, and `/A` and `/a` are distinct names.
7. **AS-79** (ownership gate) — **Given** the finished capability, **Then** `pnpm --dir packages/backend check:table-ownership --strict` reports zero findings for `asset-library`, `pnpm --dir packages/backend check:boundaries` passes, every table of this capability is in the ownership registry, no migration of this capability declares a foreign key to another owner's table, and none of this capability's specs injects another domain's model.

### Edge Cases

Each is a scenario above; the index is for reviewers.

- **Concurrency**: simultaneous commits on one base (AS-24), journal numbering (AS-29), the share cap (AS-50), quota (AS-15), reference counts (AS-44), cleanup versus commit (AS-43), cleanup versus reuse (AS-42), duplicate consumer deliveries (AS-62, AS-70, AS-71), concurrent jobs (AS-75).
- **Idempotent replay**: commit (AS-12), consumers (AS-62, AS-64, AS-70, AS-71), repeated link (AS-59), repeated refund (AS-64).
- **Illegal state transitions**: delete current version (AS-36), delete or undelete in the wrong state (AS-38, AS-39), revoke twice (AS-52), unlink sold product (AS-60), restore on a deleted asset (AS-37), version cap (AS-45).
- **Cross-tenant and IDOR**: AS-02, AS-20, AS-46, AS-52, AS-59, AS-68.
- **Limits and bad input**: AS-03, AS-09, AS-30, AS-31, AS-47, AS-56, AS-66, AS-78.
- **Timeouts and unavailable dependencies**: storage on commit (AS-17), storage while streaming (AS-57), realtime hub down (AS-33).
- **Out-of-order or duplicate events**: AS-62–AS-65, AS-70, AS-71.
- **Time boundaries**: grant grace (AS-41), share expiry (AS-51), buyer URL expiry (AS-69), retention (AS-40, AS-76), idempotency key expiry (AS-12).

## Requirements *(mandatory)*

### Functional Requirements

**Upload and dedupe**

- **FR-001**: The prepare call MUST accept 1–5,000 chunk references `{hash, size}` (hash: 64 lower-case hex characters of a SHA-256; size: integer 1 byte to 16 MiB), reject unknown properties, collapse duplicate hashes, and answer `{missing: [{hash, url, headers, expiresAt}], alreadyStored}` (AS-01, AS-02, AS-03).
- **FR-002**: Each upload permission MUST be valid for 900 seconds and be bound to one storage key, one SHA-256 and one length, so that storage itself rejects bytes that do not match; the key is derived on the server from the shop and the hash, never from client input (AS-01, AS-06).
- **FR-003**: Chunks MUST be deduplicated per shop only. A shop's answers MUST NOT reveal whether any other shop holds a hash, in content or in timing class (no cross-shop lookup is made) (AS-02).
- **FR-004**: A chunk MUST count as stored only when its bytes are confirmed present in storage. A chunk reported stored MUST be protected from cleanup for at least 24 further hours from that call (AS-05, AS-42).
- **FR-005**: A hash MUST have one size; a request that states another size for a known hash is refused with `422 chunk_size_mismatch` (AS-04).
- **FR-006**: Prepare MUST reserve the new bytes against the shop's storage quota (default 100 GiB) atomically: stored plus reserved bytes never exceed the quota, also under concurrent prepares. A prepare that adds no new bytes is never refused for quota (AS-14, AS-15).

**Commit and versions**

- **FR-007**: Commit MUST take `{path, baseVersion, chunks (≤ 15,000, ordered, repeats allowed), sizeBytes (0 – 50 GiB), deviceId}` and an `Idempotency-Key` (8–128 characters of `[A-Za-z0-9_-]`, scoped per shop and user, 24 hours). Replay returns the stored status and body with `Idempotency-Replayed: true`; a key in flight answers `409 idempotency_in_flight`; the same key with another body answers `422 idempotency_key_reuse`; a missing or malformed key answers `422` (AS-09, AS-12).
- **FR-008**: Paths MUST start with `/`, be at most 1,000 characters with segments of at most 255, have no empty, `.` or `..` segment, no trailing slash, no NUL, backslash or control character, be stored in NFC form, and be case-sensitive (AS-09, AS-78).
- **FR-009**: Commit MUST verify, before changing anything, that every listed chunk is known to this shop and present in storage, and that the chunk sizes add up to `sizeBytes`; otherwise `422 chunks_unknown`, `422 chunk_not_uploaded` or `422 size_mismatch`, with nothing persisted (AS-10).
- **FR-010**: A successful commit MUST, in one transaction, write the version, raise the reference count of each chunk by its occurrences, append the journal entry and the shop's outbox rows if any; it MUST publish the change notification only after commit (AS-07, AS-33).
- **FR-011**: A commit MUST answer one of four outcomes: `created` (no live asset at the path and the base explains why, `201`), `updated` (base equals the current version, `201`), `conflicted_copy` (`201`), `unchanged` (`200`, no state change) (AS-07, AS-13, AS-21).
- **FR-012**: A zero-byte file (no chunks) MUST be valid (AS-11).
- **FR-013**: No storage call (existence check, delete, presign) may happen while a database transaction is open; presence checks happen before the transaction and are re-validated inside it against rows protected from cleanup (AS-16).
- **FR-014**: Storage calls MUST have explicit timeouts (existence check 5 s, delete 10 s, first-byte open 10 s, idle stream 30 s); a failure on the commit path answers `503 storage_unavailable` with `Retry-After` and nothing persisted (AS-17, AS-57).
- **FR-015**: An asset MUST NOT exceed 500 versions (`409 version_limit_reached`) (AS-45).
- **FR-016**: Delta efficiency: after editing a file, a client that prepares the new chunk list MUST be told to upload only the chunks it does not already have in this shop (AS-08, AS-77).

**Conflicts**

- **FR-017**: The decision "updated or conflicted copy" MUST be taken against the current version inside the commit's transaction with a lock on the asset, so that of any number of commits on one base exactly one updates the asset (AS-24, AS-25).
- **FR-018**: A conflicted copy MUST be a new asset named by the pure rule `<name> (conflicted copy <deviceId> <UTC date>)<extension>`, with ` (2)`, ` (3)` appended before the extension when the name is taken. A conflicted copy MUST never write into an existing asset (AS-21, AS-22, AS-23).
- **FR-019**: A commit on a path with no live asset and `baseVersion > 0` (the file was deleted elsewhere) MUST create the asset at that path (`created`); a commit with `baseVersion` above the current version of a live asset MUST be refused with `422 invalid_base_version` (AS-26, AS-27).

**Change journal and reads**

- **FR-020**: Every visible change of the library (`created`, `updated`, `conflicted_copy`, restore, delete, undelete) MUST append exactly one journal entry `{seq, assetId, path, version, kind: "upsert" | "delete"}`. Numbers are per shop, start at 1, have no gaps and follow commit order. Deleting a non-current version and unchanged saves add none (AS-28, AS-29, AS-35, AS-13).
- **FR-021**: The journal read MUST take a required opaque `cursor` and a `limit` (1–1,000, default 500), return entries after the cursor in ascending order with `nextCursor` and `hasMore`, answer `422 invalid_cursor` for malformed or future cursors and `410 cursor_expired` for cursors older than the retained journal. Entries are kept 90 days (AS-28, AS-30, AS-76).
- **FR-022**: The listing MUST use keyset pagination ordered by path with the asset ID as tiebreaker, `limit` 1–100 (default 50), an optional literal `prefix`, `deleted=true` for tombstones inside the undelete window, and return `syncCursor` on the first page (AS-31).
- **FR-023**: The manifest MUST list a version's chunks in order with a 600-second download URL each, paginated by index (`from`, `limit` ≤ 2,000, default 1,000, `nextFrom`), for the current or a given version of a live asset (AS-32).
- **FR-024**: After every journaled change the library MUST publish `assets.changed {lastSeq}` on the shop's asset topic through the realtime hub, after commit; a hub failure never fails the change and is counted. Subscription is allowed to members with `products.read` (AS-33).

**Versions, deletion and cleanup**

- **FR-025**: Version listing MUST be paginated newest first (`limit` 1–100) and expose no chunk hashes (AS-34).
- **FR-026**: Deleting a version MUST be refused for the current version and for the only version (`409 cannot_delete_current_version`); otherwise it releases that version's chunk references (AS-35, AS-36).
- **FR-027**: Restore MUST create a new version with the chosen version's chunk list, with the same base check and conflict outcome as commit, no upload, and no restore on a deleted asset (`409 asset_deleted`) (AS-37).
- **FR-028**: An asset MUST have the states `ACTIVE → DELETED → PURGED`. Delete and undelete are conditional transitions (`409 invalid_transition` otherwise). Delete is refused while the asset is linked to a digital product or referenced by an entitlement (`409 asset_in_use`). Undelete is allowed for 30 days and refused if another live asset holds the path (`409 path_taken`) (AS-38, AS-39).
- **FR-029**: Purge MUST remove a deleted asset 30 days after deletion, release its versions' chunk references exactly once and remove its share links (AS-40).
- **FR-030**: A chunk's reference count MUST equal the number of its occurrences across all existing versions of the shop; it is changed only in the same transaction as the version change, never below zero (AS-44).
- **FR-031**: Cleanup MUST remove only chunks with reference count 0 that have been unreferenced for more than 24 hours and were not reported stored in that time; it deletes the storage object first, then the row, keeps the row when the delete fails and retries next run. In no interleaving with prepare, commit or purge may a committed version reference a missing object (AS-41, AS-42, AS-43).

**Share links**

- **FR-032**: Creating a share link MUST need `products.write`, a live asset of the shop, `expiresInHours` 1–720, optional `maxDownloads` 1–10,000; the token has at least 192 random bits; only its digest is stored; list and revoke are by link ID; a link's status is derived (`ACTIVE`, `EXPIRED`, `EXHAUSTED`, `REVOKED`) (AS-46, AS-47, AS-52).
- **FR-033**: Link URLs and download URLs MUST be built on the configured user-content origin, which differs from the application origin; startup fails in production when they are equal (AS-46).
- **FR-034**: Preview (`GET`) MUST NOT change state. Redeem (`POST`) MUST check expiry, revocation, cap, and the asset being live, and increment `downloads`, in one conditional update, so that the cap is never exceeded and a redeem that fails changes nothing. Every unavailable reason answers the identical `410 link_unavailable` (AS-48, AS-49, AS-50, AS-51, AS-53).
- **FR-035**: Expiry is "at or after `expiresAt` is expired", judged on the platform clock (AS-51).

**Download delivery**

- **FR-036**: A redeem or a purchase request MUST issue a download URL with an opaque token of at least 192 bits (digest stored), pinned to the asset version at issue time, valid 120 seconds (share) or 600 seconds (purchase). Fetching the URL (`GET /downloads/:token`) MUST NOT change state, MAY be repeated within its validity, MUST re-check that the grant is unexpired, the link or entitlement is not revoked and the asset not purged, and answers `410 download_unavailable` with one uniform body for every failure (AS-49, AS-52, AS-64, AS-69).
- **FR-037**: Downloads MUST be served as an attachment with the headers of AS-55, built by the pure file-name rule of AS-56, from storage in chunk order with backpressure, constant memory, and a clean `503` when the first chunk cannot be opened; later failures abort the connection (AS-55, AS-56, AS-57).
- **FR-038**: Buyer downloads MUST carry `X-Licensed-To: <buyerId>` and pass through a replaceable licensing hook (the default adds nothing); real watermarking is out of scope (AS-67).

**Digital products**

- **FR-039**: A shop member with `products.write` MUST be able to link one live asset of the shop to one product of the shop, read the link, re-link (existing active entitlements move to the new asset in the same transaction) and unlink; unlinking is refused while any entitlement exists (`409 digital_product_sold`). The product is checked through the catalog's exported lookup with the shop ID (AS-59, AS-60).
- **FR-040**: On `order.paid`, for every line whose product is linked in the line's own shop, exactly one entitlement per `(orderId, productId)` MUST exist for the order's `userId`, with a copy of the title, and `assets.entitlement_granted` is published through the outbox in the same transaction; lines of other products are ignored; a line never grants a file of another shop (AS-61, AS-62, AS-63).
- **FR-041**: On `order.refunded`, all entitlements of the order MUST become `REVOKED` (reason `refunded`) and `assets.entitlement_revoked` published once each; an order whose refund (higher `orderVersion`) was seen before or after its paid event MUST end with no active entitlement (AS-64, AS-65).
- **FR-042**: The buyer MUST be able to list their entitlements (cursor pagination, `limit` 1–100) and request a download URL for a product they hold; a missing, revoked, foreign or unknown entitlement answers the identical `404 entitlement_not_found` (AS-66, AS-67, AS-68).
- **FR-043**: Each issued purchase URL MUST increment the entitlement's `downloadCount` and set `lastDownloadAt` (AS-67).
- **FR-044**: On `catalog.product_deleted` the product's link MUST be removed (entitlements stay and keep working); on `tenancy.shop_deleted` the shop's whole library and its entitlements MUST be purged or revoked as in AS-71 (AS-70, AS-71).

**Cross-cutting**

- **FR-045**: Every shop-scoped route MUST use the tenancy guard with `products.read` for reads and `products.write` for writes; record lookups put the shop (or buyer) in the query predicate; a record outside the caller's scope answers `404`, never `403` (AS-19, AS-20, AS-68).
- **FR-046**: Rate limits (declared in S50's registry): `assets.upload.shop` 120/minute per shop for prepare and commit (fail closed); `assets.redeem.ip` 60/minute per client address for preview, redeem and download GET (fail open); `assets.grant.user` 30/minute per user for buyer download requests (fail closed). Each answers `429 rate_limited` with `Retry-After` (AS-18, AS-58, AS-72).
- **FR-047**: Event consumers (`orders.events`, `products.events`, tenancy events) MUST be idempotent on `eventId` and on their natural keys, validate their payload with the schema in `packages/contracts` before acting, and dead-letter what fails validation without side effects (AS-62, AS-63, AS-70, AS-71).
- **FR-048**: Events published through the outbox (topic `assets.events`, key `assetId` or `productId`/`entitlementId` as stated in Provides): `assets.entitlement_granted`, `assets.entitlement_revoked`, `assets.digital_product_linked`, `assets.digital_product_unlinked` (AS-59–AS-64).
- **FR-049**: Time-dependent rules (expiries, caps, grace, retention, key expiry) MUST read the platform clock so tests can freeze and advance it, including values compared inside stored queries (AS-41, AS-51, AS-69).
- **FR-050**: Scheduled jobs (registered with S49) MUST run once per schedule across replicas and be idempotent: `assets.gc-chunks` hourly, `assets.purge-deleted-assets` daily, `assets.purge-download-grants` daily, `assets.purge-changes` daily (AS-75).
- **FR-051**: Metrics and logs as AS-73 and AS-74 state; tokens, presigned URLs and request bodies are never logged.
- **FR-052**: Consistency per feature (P0610): commits, versions, reference counts, the journal, the share cap and quota are strongly consistent; entitlement grant and revocation are eventually consistent with a stated maximum staleness of 30 seconds at the 99th percentile from the order event's publication; the change notification is best effort and the journal is the truth.
- **FR-053**: All errors are `application/problem+json` with the stable `code` of each scenario; 5xx details are generic (AS-17, AS-57).
- **FR-054**: The capability MUST own its data and read other domains only through IX.7 mechanisms: product lookup is R1 (`ProductQueryService.getProductsByIds`), order data is R3 (the paid and refunded events fill the capability's own entitlement store; no order table, model or join), shop and product deletion are events; it has no foreign key to another owner's table and its transactions touch only its own tables plus the outbox (AS-79).
- **FR-055**: Shared logic that is pure (chunker, path rules, conflict naming, file-name header) lives in the capability's domain layer without framework, database or clock access (AS-23, AS-56, AS-77, AS-78).

### Key Entities *(include if feature involves data)*

- **Asset**: a file at a path in a shop's library. Status `ACTIVE`, `DELETED` (with `deletedAt`), then purged. Holds the current version number.
- **Asset version**: an immutable ordered list of chunk hashes with total size, creator, device and time. Never edited; deleted only when not current.
- **Chunk**: content-addressed bytes of one shop, with size, reference count, and the time since it was last unreferenced or reused. Stored once per shop.
- **Shop storage usage**: stored plus reserved bytes per shop, compared with the quota.
- **Change journal entry**: one numbered entry per visible change, per shop, with a retention floor.
- **Share link**: the digest of a random token, asset, expiry, optional cap, counter, revocation, creator.
- **Download grant**: a short-lived, version-pinned, digest-stored token to fetch bytes; kind `share` or `purchase`; refers to a link or an entitlement.
- **Digital product link**: one product of a shop pointing to one asset of the shop.
- **Entitlement**: a buyer's right, from one paid order line, to one digital product's file: status `ACTIVE` or `REVOKED` with reason, title copy, download counter. Keyed by order and product.
- **Order revocation record**: the fact that an order was refunded, with the order version, so that a late or replayed paid event grants nothing.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web` and `specs/journeys` for `S31` and `asset-library`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from this capability and how they are honoured:

- **S10** (`orders`): lists S31 as the consumer of `order.paid` → entitlement (honoured: FR-040, AS-61..AS-65, reading `lines[].{productId, shopId, title}`, `userId`, `orderVersion` and the `order.refunded` event) and as a consumer of `OrderQueryService.getOrderLines`. **Not honoured as a call**: this capability needs no order read after the move to events (R3), so it does not call `getOrderLines`; asset-library's `BisOrder` and `BisOrderItem` SQL is removed rather than migrated (a `[CONTRACT]` question in `questions.md`). S10 removes the `BisOrderModel` exports from its barrel after S31 migrated (S10 `gaps.md` D-7 row).
- **S05** (`catalog`): requires S31 to replace its product-in-shop SQL with `ProductQueryService.getProductsByIds([id], {shopId})` (honoured: FR-039, AS-59) and, as a snapshot consumer, `catalog.product_deleted` (FR-044).
- **S03** (`tenancy`): requires every domain to purge its shop data on `tenancy.shop_deleted` (honoured: FR-044, AS-71) and to use `ShopScoped` with the permission matrix of its FR-020 (honoured: `products.read`, `products.write`; no new permission asked).
- **S29/S30** and the others name no S31 contract.

**Provides** (exact names; exported from `@app/domains/asset-library` unless it is an HTTP endpoint):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts` (`assetPrepareRequestSchema`, `assetPrepareResponseSchema`, `assetCommitRequestSchema`, `assetCommitResponseSchema`, `assetSchema`, `assetPageSchema` = `{items, nextCursor, syncCursor}`, `assetVersionPageSchema`, `assetChangePageSchema` = `{items, nextCursor, hasMore}`, `assetManifestSchema`, `shareLinkCreateRequestSchema`, `shareLinkSchema`, `shareLinkPreviewSchema`, `downloadGrantSchema`, `digitalProductLinkSchema`, `purchasePageSchema`, `assetEventSchemas`):
  - Library (`ShopScoped`; reads `products.read`, writes `products.write`): `POST /shops/:shopId/assets/prepare` → `200`; `POST /shops/:shopId/assets/commit` (`Idempotency-Key`) → `201` or `200 unchanged`; `GET /shops/:shopId/assets?prefix&deleted&limit&cursor`; `GET /shops/:shopId/assets/changes?cursor&limit`; `GET /shops/:shopId/assets/:assetId/versions?limit&cursor`; `GET /shops/:shopId/assets/:assetId/manifest?version&from&limit`; `DELETE /shops/:shopId/assets/:assetId` → `204`; `POST /shops/:shopId/assets/:assetId/undelete` → `200`; `DELETE /shops/:shopId/assets/:assetId/versions/:version` → `204`; `POST /shops/:shopId/assets/:assetId/versions/:version/restore {baseVersion}` → `201`.
  - Share: `POST /shops/:shopId/assets/:assetId/share {expiresInHours, maxDownloads?}` → `201 shareLinkSchema` with the token (only here); `GET /shops/:shopId/assets/:assetId/share-links`; `DELETE /shops/:shopId/assets/:assetId/share-links/:linkId` → `204`; anonymous: `GET /assets/shared/:token` → preview, `POST /assets/shared/:token/redeem` → `200 {url, expiresAt, fileName, sizeBytes}`.
  - Digital: `PUT /shops/:shopId/products/:productId/digital-asset/:assetId` → `204`; `GET` and `DELETE /shops/:shopId/products/:productId/digital-asset`; buyer (`Firewall` session): `GET /me/purchases?limit&cursor` → `purchasePageSchema`; `POST /me/purchases/:productId/download` → `200 {url, expiresAt, expiresInSec: 600}`; anonymous: `GET /downloads/:token` → bytes (no state change).
  - **Consumers**: sync clients (desktop, CLI, mobile); the web capabilities that will own the library, share and "My purchases" screens (a `[CONTRACT]` question); the BFF (S48) reaches these only over HTTP (R2) if it ever composes them.
- Events (outbox → topic `assets.events`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`), key and payloads:
  - `assets.entitlement_granted` (key `entitlementId`) `{entitlementId, orderId, productId, shopId, buyerId, title, grantedAt}`. **Consumer: S28** (mail "your download is ready"; the mail contains no download URL, the buyer uses "My purchases").
  - `assets.entitlement_revoked` (key `entitlementId`) `{entitlementId, orderId, productId, shopId, buyerId, reason: 'refunded' | 'shop_deleted', revokedAt}`. **Consumer: S28** (optional notice).
  - `assets.digital_product_linked` / `assets.digital_product_unlinked` (key `productId`) `{productId, shopId, assetId, linkedAt | unlinkedAt}`. **Consumers: S32 and S29-style read models that want a "digital" flag** (none required today).
- Realtime (hub: S51): topic `shop:<shopId>:assets`, event `assets.changed {lastSeq}`; subscription authorized by shop membership with `products.read`.
- Rate-limit policies (declared in S50's registry): `assets.upload.shop`, `assets.redeem.ip`, `assets.grant.user` (FR-046).
- Scheduled jobs (registered with S49): `assets.gc-chunks`, `assets.purge-deleted-assets`, `assets.purge-download-grants`, `assets.purge-changes`.
- Modules for the apps: `AssetsModule` (core: HTTP) and `AssetsWorkerModule` (worker: jobs and the consumers of `orders.events`, `products.events` and tenancy events). No R1 service is exported (no spec asks for one), and nothing else is exported: no model, repository, job class or port implementation (X.4, D-8).

**Requires**:

- **S01** (`identity`): `Firewall({ anonymous?, … })`, `@User()` returning `{id, role, sessionId, amr}`.
- **S03** (`tenancy`): `ShopScoped(permission)` with the status gate and the permission names `products.read`, `products.write`; event `tenancy.shop_deleted {shopId}` on the shop topic (envelope as S03's spec).
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[] (≤ 500), options?: { shopId?: ShopId }): Promise<Map<ProductId, ProductDto>>` using `ProductDto.id` and `ProductDto.shopId` (absent ID = not found); event `catalog.product_deleted {productId, shopId, productVersion}` on `products.events`.
- **S10** (`orders`): topic `orders.events`; `order.paid {orderId, userId, paidAt, lines: [{productId, shopId, title, quantity, …}], orderVersion}` and `order.refunded {orderId, userId, orderVersion, …}` (schemas `orderEventSchemas` in `packages/contracts`); `orderVersion` rises with every order change; a refund is a terminal state of the whole order.
- **S49** (`jobs`): scheduled and recurring jobs with single-run guarantee.
- **S50** (`rate-limit`): the three policies above and `429` with `Retry-After`.
- **S51** (`realtime`): `publish(topic, event, payload)` through the topic registry (the exact exported name is S51's), best effort.
- **S53** (`events`): outbox append inside the domain's transaction, the consumer toolkit (inbox on `eventId`, zod validation, DLQ), schemas in `packages/contracts`.
- **S54** (`platform`): problem+json filter with stable `code`, idempotency facility (`Idempotency-Key` semantics of V.6), clock, metrics registry, config schema with `usercontent_origin`, request-context transactions.
- Infrastructure (no capability): the object-storage port with checksum-bound presigned PUT (`presignPutChecked`), presigned GET, existence check, ordered stream read and delete, each with a caller-set timeout.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After editing the middle of a 1 GiB file, a sync re-sends at most 3 chunks (about 1% of the bytes) and the saved version downloads byte-identical, in every run of the delta-sync scenario.
- **SC-002**: When any number of devices save the same file from the same base at once, 100% of the contents survive, as either the next version or a conflicted copy; none is silently overwritten.
- **SC-003**: A share link capped at N downloads never delivers more than N downloads, even when 100 people click at the same instant; opening or previewing a link never uses up a download.
- **SC-004**: A buyer's download right appears within 30 seconds (99th percentile) of the order being paid and disappears within 30 seconds of the refund; a buyer link never works for anyone but the intended download within 10 minutes, and never after the right is revoked.
- **SC-005**: Zero committed file versions point at missing bytes, in every interleaving of upload, commit, delete and cleanup the tests exercise.
- **SC-006**: Bytes no version needs are reclaimed within 25 hours of their last use, and never before 24 hours.
- **SC-007**: Zero successful cross-shop reads or writes across the full permission-and-ownership test matrix; a shop cannot tell whether another shop holds a file.
- **SC-008**: Uploads and downloads of files up to 50 GiB do not need the application to hold the file in memory, and the application never receives the bytes of an upload.
- **SC-009**: Every error a client can receive from this capability has a stable machine-readable code and no internal detail.

## Assumptions

Each assumption is also a line in [`questions.md`](questions.md).

- **Notes win over code**: per-shop dedupe, 4 MiB average chunks, content-defined chunking, change journal with cursor, conflicted copy, share links with expiry, short-lived signed downloads and reference-counted asynchronous cleanup all come from `08-media-and-files.md` design 25; direct-to-storage uploads, server-made keys, `attachment` plus `nosniff` and a separate user-content origin come from design 27.
- **Production-grade over compatibility** (no external clients): the share link `GET` no longer downloads, buyer download tokens are opaque grants instead of signed tokens, commit needs an `Idempotency-Key`, the journal cursor is opaque, order data comes from events. See `[BREAKING]` lines.
- **No per-folder ACLs**: library access follows shop roles (`products.read` / `products.write`); notes' folder ACL inheritance is not built. Renames and moves are delete plus create.
- **No retroactive delivery**: a product must be linked before it is sold. Orders paid before the link get no entitlement; the seller links before listing.
- **Digital files are the seller's responsibility**: the platform does not scan them. Delivery is always `attachment` on the user-content origin so a hostile file cannot run in the platform's origin.
- **Quota** is a single default (100 GiB per shop, configurable) until S18 supplies per-plan values; counts physical unique chunk bytes held or reserved.
- **Limits** are constants: chunk 16 MiB, 5,000 chunks per prepare, 15,000 per commit, file 50 GiB, 500 versions, journal 90 days, undelete window 30 days, cleanup grace 24 hours, upload permission 900 s, manifest URL 600 s, share grant 120 s, buyer grant 600 s.
- **A refund event means a full refund** (order status `REFUNDED`); any `order.refunded` revokes all of the order's entitlements.
- **Entitlement is per order line and product**, with quantity ignored; one buyer who buys twice has two entitlements.
- **Buyer downloads are not resumable** and are streamed through the application; sync clients resume by chunk through the manifest.
- **Paths are case-sensitive and NFC-normalized.**
- **The Interview-Prep copy of SD-25 is absent**; the repository's `docs/showcase/sections/SD-25-seller-media-library.md` and design 25 and 27 are the sources. The SD-25 mention of `scripts/asset-sync-cli.ts` does not exist; a reference client is a test helper, not a deliverable.
- **Web screens** and the sync client are owned elsewhere; this spec fixes only the HTTP contract they use.
