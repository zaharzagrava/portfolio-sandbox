---

description: "Task list for S31 — Shop Asset Library and Digital Product Delivery"
---

# Tasks: S31 — Shop Asset Library and Digital Product Delivery (domain `asset-library`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `research.md` (D1–D8), `data-model.md`, `contracts/interfaces.md`, `quickstart.md`.

**Tests**: Required (constitution VII, `test-plan.md`). Test-first: for each test-plan row the failing test task comes before the code task. Backend specs run through `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>` from `packages/backend`.

**Path shorthand**: `AL/` = `packages/backend/libs/domains/asset-library/`; `CT/` = `packages/contracts/src/asset-library/`; `MIG/` = `packages/backend/migrations/`.

**Rules for every task**: time only from the platform `Clock` (no `now()` in SQL, no `new Date()`); transactions only through `TransactionRunner.run` / `@Transactional`, never a new `sequelize.transaction`; delete each `// S54 T037 audit` comment you migrate (`AL/application/assets.service.ts:134,224`); no storage call inside a transaction; no model, SQL or FK on another owner's table; never create or edit `*.reviewed.json`; no runtime-proof tasks (fresh stack, standalone boot, journey/browser suite) — deferred to the final checkpoint. Each test creates its own data (L-005, L-006), must be able to fail (L-003), and the new e2e specs replace `assets.e2e-spec.ts` scenario by scenario (L-017). If one test still fails after 5 fix attempts, write the blocker in `questions.md` and stop.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Create the living-spec page `docs/spec/capabilities/S31-assets-digital-delivery.md` (rules and behaviors for upload, conflicts, lifecycle, share, digital delivery, operations, each with `[proof: …]` at the e2e files of `test-plan.md` and `[code: …]` at `AL/` files as they land) plus the asset and entitlement status-machine page the data model calls for; run `python3 scripts/livespec/check.py`; never touch `*.reviewed.json`
- [X] T002 [P] Create zod schemas in `CT/` (`prepare.ts`, `commit.ts`, `asset.ts`, `changes.ts`, `manifest.ts`, `share.ts`, `grant.ts`, `digital.ts`, `events.ts`, `index.ts`) exactly as listed in `contracts/interfaces.md` (outcome enum `created|updated|conflicted_copy|unchanged`; request schemas `.strict()`; `assetEventSchemas` for the four `assets.*` events) and export from the `packages/contracts` index (gap A28)
- [X] T003 [P] Add config keys validated at boot with defaults: `usercontent_origin` (startup fails in production when equal to the app origin), `assets_quota_bytes` 100 GiB, `assets_version_cap` 500, `assets_undelete_days` 30, `assets_journal_days` 90, `assets_gc_grace_hours` 24, in the backend config module and env examples
- [X] T004 [P] Add `fast-check` as a dev dependency of `packages/backend` if absent

---

## Phase 2: Foundational (blocks every story)

**Pure domain, tests first (AS-23, AS-56, AS-77, AS-78; gaps A3, A8, A32, A34)**

- [X] T005 [P] Write failing unit spec `AL/domain/asset-path.spec.ts` (`it.each` over valid/invalid paths, NFC forms, case-distinct paths; AS-78)
- [X] T006 [P] Write failing unit spec `AL/domain/conflict-name.spec.ts` (`it.each`: extension, dot file, dotted directory, double extension, taken names → `(2)`, `(3)`, UTC date edge; AS-23)
- [X] T007 [P] Write failing unit spec `AL/domain/content-disposition.spec.ts` (`it.each`: quotes, CR/LF, `;`, `\`, `%`, long, control-only, empty, non-ASCII; ASCII `filename` plus RFC 6266 `filename*`; AS-56)
- [X] T008 [P] Extend `AL/domain/fastcdc.spec.ts` with `fast-check` properties (reconstruction, bounds, determinism, ≤ 3 changed chunks per insertion, mean size, short input, empty input; AS-77, gap A32)
- [X] T009 [P] Write failing unit spec `AL/domain/chunk-plan.spec.ts` for the reference-count planner (occurrences per distinct hash; a hash listed twice counts 2; AS-44)
- [X] T010 [P] Implement `AL/domain/asset-path.ts` (path rules, NFC, case-sensitive; FR-055)
- [X] T011 [P] Implement `AL/domain/conflict-name.ts` (device id, UTC date from a passed clock value, `(n)` collision numbering; pure)
- [X] T012 [P] Implement `AL/domain/content-disposition.ts`
- [X] T013 [P] Implement `AL/domain/chunk-plan.ts`
- [X] T014 [P] Create `AL/domain/limits.ts` (prepare ≤ 5,000 chunks, commit ≤ 15,000, chunk ≤ 16 MiB, file ≤ 50 GiB, versions ≤ 500, share grant 120 s, buyer grant 600 s, manifest URLs 600 s, upload permission 900 s, idempotency 24 h) and `AL/domain/errors.ts` with the problem catalog registered by `ProblemCatalogModule.forFeature(ASSET_PROBLEMS)` (codes and statuses exactly as `contracts/interfaces.md`; 5xx detail generic; gap A28)
- [X] T015 Adjust `AL/domain/fastcdc.ts` only if T008 fails; run `test-spec.sh libs/domains/asset-library/domain` until green

**Schema and ownership**

- [X] T016 Write expand migration `MIG/20261010100000-asset-library-expand.js` (with `lock_timeout`, dated after `20261003090000`) per `data-model.md`: `Asset.status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK IN ('ACTIVE','DELETED','PURGED')` backfilled from `deleted`, `deletedAt timestamptz NULL`, `createdAt`; unique `(shopId, path) WHERE status = 'ACTIVE'`; keyset index `(shopId, path, id) WHERE status = 'ACTIVE'`; `(status, deletedAt) WHERE status = 'DELETED'`; `AssetVersion` rename `size → sizeBytes` and index `(assetId, version DESC)`; `AssetChunk` add `storedAt timestamptz NULL`, `protectedUntil timestamptz`, `deleting boolean DEFAULT false`, `reserved boolean`, GC index `(protectedUntil) WHERE "refCount" = 0`; `AssetSyncState.minSeq BIGINT NOT NULL DEFAULT 0`; `AssetChange (at)` index; `AssetShareLink` add `id UUID`, `shopId`, `createdBy`, `createdAt`, `revokedAt`, PK moves to `id`, `tokenHash` unique index; `DigitalProduct` add `shopId`, `linkedAt` (gaps B2, B3, B5, B6, B7)
- [X] T017 In the same migration or a sibling, create tables `AssetVersionChunk` (**assetId, version, hash**, shopId, occurrences INT; index `(shopId, hash)`), `AssetShopUsage` (**shopId**, storedBytes BIGINT, reservedBytes BIGINT, `CHECK (storedBytes >= 0 AND reservedBytes >= 0)`), `AssetEntitlement` (unique `(orderId, productId)`; keyset `(buyerId, grantedAt DESC, id) WHERE status = 'ACTIVE'`; `(buyerId, productId) WHERE status = 'ACTIVE'`; `(productId)`; `(assetId)`; status `'ACTIVE'|'REVOKED'`, revokedReason `'refunded'|'shop_deleted'`), `AssetDownloadGrant` (**tokenHash CHAR(64)**, kind `'share'|'purchase'`, index `(expiresAt)`), `AssetOrderRevocation` (**orderId**, orderVersion, revokedAt); backfill `AssetVersionChunk` from `AssetVersion.chunks` (gaps B4, B8)
- [X] T018 Write contract migration `MIG/20261010110000-asset-library-contract.js`: drop FK `Asset.shopId → Shop`, FK `DigitalProduct.productId → Product` (cascade replaced by the consumer), the `AssetShareLink → Asset` cascade FK, then column `Asset.deleted` (gap B1, section C)
- [X] T019 Register every new and changed table in `packages/backend/db/ownership.ts` (`domain:asset-library`), update `docs/work/architecture/domain-map.md` (owned tables, `Depends on: orders (events), catalog (R1 + event), tenancy (events), realtime`; drop the "replaces the BisOrder reads" wording); create/update Sequelize models for the new tables under `AL/infra/` so `check:model-registry` resolves them in `core`, `worker` and `projector`

**Layering (D-6)**

- [X] T020 Define ports and tokens in `AL/domain/ports.ts` (asset, version, chunk, journal, share, entitlement, grant, usage repositories; `ChunkStore`); no Sequelize or storage imports in `domain/`
- [X] T021 [P] Implement repositories in `AL/infra/` (`asset.repository.ts`, `version.repository.ts`, `chunk.repository.ts`, `journal.repository.ts`, `share.repository.ts`, `entitlement.repository.ts`, `grant.repository.ts`, `usage.repository.ts`): Sequelize only here, multi-row statements, conditional `UPDATE … WHERE status`, `FOR UPDATE SKIP LOCKED` where jobs claim work, opaque keyset cursors (III.10)
- [X] T022 [P] Implement `AL/infra/chunk-store.ts` (`ObjectStorage` adapter: key derived server-side from shop and hash; `presignPutChecked`, `head`, `getStream`, `delete`; bounded timeouts → `storage_unavailable`; a test gate/latch hook for AS-12 and AS-16)
- [X] T023 [P] Create `AL/rate-limit-policies.ts` (`assets.upload.shop` 120/60 s key `shop` closed; `assets.redeem.ip` 60/60 s key `ip` open; `assets.grant.user` 30/60 s key `user` closed) with `RateLimitModule.forFeature`
- [X] T024 [P] Create `AL/application/events/asset-events.ts` (`defineEvent` for the four `assets.*` events on topic `assets.events`, keys per `contracts/interfaces.md`) and `AL/application/asset-metrics.ts` (counters, gauges, histograms of AS-73)
- [X] T025 Restructure `AL/assets.module.ts` into `AssetsModule`, `AssetsWorkerModule` (no HTTP-facing service; jobs and schedule upsert in the module; gap A31) and `AssetsProjectorModule`, each importing what it uses so it boots alone (L-018, L-015); keep `AL/index.ts` exporting only the modules (including the realtime topics module; X.4)
- [X] T026 Create the e2e helper `AL/asset-client.ts` (chunk with the exported pure chunker at test parameters 4/16/64 KiB, prepare, real PUT to issued URLs, commit with `Idempotency-Key`, manifest GET, a fixture to seed N versions; users, shops and roles from S03 fixtures, products from S05 fixtures; clock freeze/advance; recording realtime-hub fake with a failure switch) and zod pipes `AL/api/zod.pipes.ts`

**Checkpoint**: `tsc --noEmit` passes, migrations apply, domain unit specs green.

---

## Phase 3: User Story 1 — Sync a big file, re-upload only what changed (P1) 🎯 MVP

**Goal**: prepare/commit with dedupe, quota, idempotency, integrity. Gaps A1–A6, A10, A23, A29, A3, A4; AS-01…AS-18.

**Independent Test**: `test-spec.sh asset-upload`.

- [X] T027 [US1] Create `AL/asset-upload.e2e-spec.ts` (describe "Asset library: prepare, dedupe, commit, quota and idempotency") with prepare scenarios AS-01 (missing only, 900 s permissions), AS-02 (dedupe in call, across files, never across shops), AS-03 (`it.each` invalid bodies `400`; 5,000 chunks and 16 MiB boundary `200`), AS-04 (`422 chunk_size_mismatch`), AS-05 (never-uploaded chunk missing again after 10 min and 3 h by clock, stored after real PUT), AS-06 (wrong bytes/length refused by MinIO, expired permission refused)
- [X] T028 [US1] Add commit scenarios to the same file: AS-07 (`201` body, refcounts, journal seq 1, one hub event), AS-08 (1 MiB random file, 20-byte insertion, ≤ 3 missing, refcounts, byte-identical download via manifest), AS-09 (`it.each` path/chunk/size/base/device/header classes; 15,000 chunks and 50 GiB boundaries pass), AS-10 (unknown, not uploaded, other shop's hash, size mismatch; nothing persisted), AS-11 (empty `.gitkeep`, zero-chunk manifest, `size_mismatch` for 5), AS-13 (`200 unchanged`, no rows or events)
- [X] T029 [US1] Add AS-12 (replay with header → one version; gated in-flight `409`; different body `422`; other shop/user independent; key expiry by clock), AS-14 (small configured quota → `409 quota_exceeded`, dedupe-only `200`, success after delete and cleanup), AS-15 (two 6 MiB prepares via `Promise.all`: one `200`, one `409`, usage ≤ quota), AS-16 (gate in existence check; lock probe on chunk rows succeeds; then `201`), AS-17 (forced storage timeout → `503` + `Retry-After`, generic detail, nothing persisted, failure metric, retry `201`), AS-18 (121st call `429` with `Retry-After`, no write, other shop free, reads free)
- [X] T030 [US1] Implement prepare in `AL/application/upload.service.ts`: validate with the T002 schemas and T014 limits; confirm presence in storage (bounded `head`) outside any transaction before setting `storedAt`; one multi-row insert for missing chunks; reserve quota by conditional update (`storedBytes + reservedBytes + $n <= quota`) in `TransactionRunner.run`; restart `protectedUntil` for reused chunks; compare size of an existing hash (`chunk_size_mismatch`); times from `Clock` (gaps A1, A2, A23, A29)
- [X] T031 [US1] Implement commit in `AL/application/upload.service.ts`: `Idempotency-Key` required (8–128 chars) through the S54 idempotency facility (replay stored `201`; same key different body `422`; in flight `409`); existence check before the transaction, re-validation inside against chunks with live `protectedUntil` and `storedAt`; version cap `409 version_limit_reached`; empty file allowed; `unchanged` → `200` with no rows or events; response `{assetId, path, version, outcome, conflicted, sizeBytes}`; semantic failures `422 chunks_unknown|chunk_not_uploaded|size_mismatch|invalid_base_version`; write `AssetVersionChunk` occurrences and counters; journal and outbox in the same transaction; storage timeouts → `503 storage_unavailable` (gaps A3–A6, A10); migrate the `// S54 T037 audit` site at `AL/application/assets.service.ts:134` and delete its comment
- [X] T032 [US1] Create `AL/api/library.controller.ts` prepare and commit routes (replace those of `AL/api/assets.controller.ts`) with `ShopScoped`, `Firewall`, permission `products.write`; apply `assets.upload.shop` in the service (`429` + `Retry-After`)
- [X] T033 [US1] Run `test-spec.sh asset-upload` until green

**Checkpoint**: US1 fully functional and testable alone.

---

## Phase 4: User Story 2 — Two devices edit one file, nothing is lost (P1)

**Goal**: conflicted copies, gapless journal, listing, manifest, notification. Gaps A7, A9, A12, A13, A25; AS-21…AS-33.

**Independent Test**: `test-spec.sh asset-sync`.

- [X] T034 [US2] Create `AL/asset-sync.e2e-spec.ts` (describe "Asset library: conflicts, change journal, listing, manifest and notifications") with AS-21 (stale save → conflicted copy, both contents download), AS-22 (second and third conflict same day → `(2)`, `(3)`, earlier copy untouched), AS-24 (`Promise.all` two commits on one base: one `updated`, one `conflicted_copy`, versions `[1,2]` and `[1]`, consecutive seq), AS-25 (base 0 on existing path), AS-26 (edit vs delete → `created` new asset), AS-27 (`422 invalid_base_version {currentVersion}`)
- [X] T035 [US2] Add AS-28 (5 changes, pages 2/2/1 via `nextCursor`, empty page keeps cursor), AS-29 (20 parallel commits → `n+1..n+20`, no gaps/duplicates), AS-30 (missing, malformed, future cursor `422 invalid_cursor`; `limit` 0 and 1001; the expired-cursor assertion is made once, in T058 as AS-76), AS-31 (7 live + deleted + foreign, pages 3/3/1, prefix with `%`/`_`, `deleted=true`, `syncCursor`, limit bounds), AS-32 (manifest pages by `from`, real GET of every URL byte-identical, version param, unknown version, deleted asset `404`, limit bound), AS-33 (one `assets.changed {lastSeq}` per journaled change on `shop:<shopId>:assets`, none for `unchanged`; hub forced down → commit `201`, failure counted)
- [X] T036 [US2] Implement the conflict decision in `AL/application/upload.service.ts` using `AL/domain/conflict-name.ts`: stale or base-0-on-existing → conflicted copy with `(n)` numbering, never writing into an existing asset; base from the future → `422`; concurrent saves serialized by the asset row lock; deleted asset + stale edit → `created` (gaps A7, A8, A9)
- [X] T037 [US2] Implement the gapless journal in `AL/infra/journal.repository.ts` from a locked `AssetSyncState` counter row (D4): opaque cursor (III.10), `limit` bounds, `422 invalid_cursor`, `410 cursor_expired` below `minSeq`; response `{items, nextCursor, hasMore}` (gap A12)
- [X] T038 [US2] Implement `AL/application/library.service.ts` listing (`assetPageSchema` with `syncCursor`, prefix escape for `%`/`_`, `deleted=true`) and the paginated manifest (`{chunks:[{index,hash,sizeBytes,url}], totalChunks, nextFrom}`, 600 s URLs, `404` for deleted assets, strict `version` parsing; gap A13)
- [X] T039 [US2] Publish `assets.changed {lastSeq}` through `RealtimePublisher` on `shop:<shopId>:assets` after every journaled change; failures are caught and counted, never fail the request; keep `AL/api/realtime-topics.ts` registered through `TopicRegistry.define` (S51 follow-up, gap A25)
- [X] T040 [US2] Add list, journal and manifest routes to `AL/api/library.controller.ts` (`products.read`); run `test-spec.sh asset-sync` until green

---

## Phase 5: User Story 3 — History, deletion and cleanup that never destroy live bytes (P2)

**Goal**: version history, delete/undelete/restore/purge, safe cleanup. Gaps A11, A22; AS-34…AS-45.

**Independent Test**: `test-spec.sh asset-lifecycle`.

- [X] T041 [US3] Create `AL/asset-lifecycle.e2e-spec.ts` (describe "Asset library: versions, delete, restore, retention and chunk cleanup") with AS-34 (history pages 2/2/1 newest first, no hashes), AS-35 (delete old version `204`, refcounts, no journal entry), AS-36 (current, only, unknown, already deleted → `409`/`404`), AS-37 (restore creates v4 from v1's chunks with no upload; stale base → copy; deleted asset `409`), AS-38 (delete file `204`, `DELETED`, journal `delete`, path free, versions kept, share link `410`, second delete `409`, `asset_in_use`), AS-39 (undelete `200`, `path_taken`, active `409`, purged `404`)
- [X] T042 [US3] Add AS-40 (clock at 30 d ∓ 1 s, exact single release, double and concurrent purge, no negative count), AS-41 (23 h 59 m / 24 h 1 s / stale marker with refcount 1; object deleted first, row kept on forced delete failure and retried), AS-42 (25-h-old chunk reused by prepare survives cleanup, then commit and download), AS-43 (`Promise.all(commit, cleanup)`: `201` with object present or `422`, every chunk readable), AS-44 (10 parallel commits sharing a chunk, one listing it twice → 11; delete in two orders → 0 exactly, then collectable), AS-45 (500 seeded versions via the fixture, `409 version_limit_reached`, success after deleting one)
- [X] T043 [US3] Implement in `AL/application/library.service.ts`: version history page, `deleteVersion` (refuses current/only version `409 cannot_delete_current_version`, no journal entry, exact occurrence decrements), asset delete (`ACTIVE → DELETED` conditional update, journal `delete`, `asset_in_use` guard for linked or entitled assets), undelete (window `assets_undelete_days`, `path_taken`), restore a version (new version reusing chunks; stale base → copy), all through conditional `UPDATE … WHERE status = $from` (gap A11)
- [X] T044 [US3] Implement `AL/application/cleanup.service.ts` and the `assets.gc-chunks` / `assets.purge-deleted-assets` handlers in `AL/infra/assets.jobs.ts`: claim with `FOR UPDATE SKIP LOCKED` and the `deleting` flag (D2); delete the object first and the row only on success; keep and count failures; honour `protectedUntil` and `assets_gc_grace_hours`; no interpolated SQL; purge after the undelete window releasing counts exactly once and removing links explicitly (gap A22); migrate the `// S54 T037 audit` site at `AL/application/assets.service.ts:224` to `TransactionRunner` and delete the comment
- [X] T045 [US3] Add versions, delete, undelete and restore routes to `AL/api/library.controller.ts` (`products.write`; history `products.read`); run `test-spec.sh asset-lifecycle` until green

---

## Phase 6: User Story 4 — Share a file by link with expiry and cap (P1)

**Goal**: preview/redeem/download split, revoke, safe headers. Gaps A14–A17, A24; AS-46…AS-58.

**Independent Test**: `test-spec.sh asset-share`.

- [X] T046 [US4] Create `AL/asset-share.e2e-spec.ts` (describe "Asset library: share links and download delivery") with AS-46 (`201` body, token ≥ 32 chars, URL on `usercontent_origin`, only digest stored, list without tokens, foreign and deleted asset `404`), AS-47 (`it.each` invalid `expiresInHours`/`maxDownloads`, boundaries `201`, max 10,000), AS-48 (5 previews `200`, `downloads` 0, identical `410` body for every unavailable reason), AS-49 (redeem `200` count 1, GET bytes identical, repeat GET same count, 121 s → `410`), AS-50 (cap 3, 10 `Promise.all` redeems → 3 `200` + 7 `410`), AS-51 (`T − 1 s` `200`, `T` `410`)
- [X] T047 [US4] Add AS-52 (revoke `204`, status, redeem `410`, outstanding URL `410`, second revoke `409`, foreign link `404`), AS-53 (deleted asset → `410`, count unchanged; undelete → works), AS-54 (v2 served after redeem; issued URL keeps its version), AS-55 (`/promo/pic.svg` exact headers: `attachment`, `nosniff`, `Referrer-Policy: no-referrer`, no cookie), AS-57 (first chunk unavailable → `503` before any byte; later chunk fails → aborted short body, metric, no leak), AS-58 (61st preview/redeem/download `429`, no counter change, other address free; limiter store off → fail open)
- [X] T048 [US4] Implement `AL/application/share.service.ts`: create (no silent clamp, `maxDownloads` ≤ 10,000, `{id, token, url, expiresAt, maxDownloads, createdAt}`, 192-bit random token, digest stored, `createdBy`), list, revoke (guarded), derived status, stateless preview, redeem (check asset, expiry, revoke, then conditional counter increment `downloads < maxDownloads`; mint an `AssetDownloadGrant` of 120 s pinned to the current version), uniform `410 link_unavailable`; remove the optional `shopId` parameter of `version()` (gaps A16, A17, A24)
- [X] T049 [US4] Implement `AL/application/delivery.service.ts`: grant lookup by digest (uniform `410 download_unavailable`), open the first chunk before sending headers, stream with constant memory and bounded timeouts, abort on mid-stream failure with a metric, `Content-Disposition` from `AL/domain/content-disposition.ts`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, no cookies, user-content origin check (gaps A14, A15)
- [X] T050 [US4] Create `AL/api/share.controller.ts` and `AL/api/downloads.controller.ts` (`GET /assets/shared/:token` preview, `POST /assets/shared/:token/redeem`, `GET /downloads/:token`, owner create/list/revoke with `products.write`); anonymous routes explicit `anonymous: true`; `assets.redeem.ip` limit fail-open; remove the old share and stream routes from `AL/api/assets.controller.ts`; run `test-spec.sh asset-share` until green

---

## Phase 7: User Story 5 — Buyer pays, downloads; refund takes it away (P1)

**Goal**: digital link, entitlements from events, purchases, buyer grants, product and shop deletion. Gaps A18–A21, A30, B1, section C; AS-59…AS-72; S05 and S10 follow-ups.

**Independent Test**: `test-spec.sh digital-delivery` and `test-spec.sh digital-events`.

- [X] T051 [US5] Create `AL/digital-delivery.e2e-spec.ts` (describe "Digital delivery: product link, purchases and buyer downloads") with AS-59 (`204`, `GET` link, one outbox event, repeat no event, foreign product/asset/unknown/deleted `404`, VIEWER `403`), AS-60 (re-link moves entitlements, unlink with entitlements `409 digital_product_sold`, free unlink `204` + event, unlinked `404`), AS-66 (3 active + 1 revoked, other buyer, pages 2/1, limit bounds, `401`), AS-67 (grant `200`, counter and `lastDownloadAt`, GET bytes identical, `X-Licensed-To`, version pinned across a v2 commit), AS-68 (non-buyer, shop member, unknown product, revoked → identical `404`; `401`), AS-69 (`expiresAt − 1 s` `200`, `expiresAt` `410`; tampered, truncated, empty, cross-kind, purged → identical `410`), AS-72 (31st request `429` with `Retry-After`, no counter change, other buyer free)
- [X] T052 [US5] Create `AL/digital-events.e2e-spec.ts` (describe "Digital delivery: consumers of orders, products and tenancy events", VII.4), delivering contract-valid events and never creating `BisOrderModel` rows: AS-61 (`order.paid` → one entitlement with title, none for non-digital line, quantity 3 → one, outbox event), AS-62 (duplicate twice in sequence and via `Promise.all` → one entitlement, one event), AS-63 (`it.each` malformed payloads dead-lettered with no rows; foreign-shop line ignored; next message processed), AS-64 (`order.refunded` twice → revoked once, one event, grant request `404`, outstanding URL `410`), AS-65 (refund before paid, paid replay after refund, unrefunded paid grants), AS-70 (`catalog.product_deleted`: link removed once, one event, entitlements still download, invalid payload dead-lettered, unknown product tolerated), AS-71 (`tenancy.shop_deleted`: full purge of S1, entitlements revoked with events, S2 untouched, duplicate no-op, invalid payload dead-lettered)
- [X] T053 [US5] Implement `AL/application/digital.service.ts` link side: `PUT`, `GET`, `DELETE`; product check through `ProductQueryService.getProductsByIds([productId], { shopId })` from `@app/domains/catalog` (R1, S05 follow-up; gap A21, section C); asset-in-shop and not-deleted as own-table checks; re-link moves entitlements; sold guard `409 digital_product_sold`; outbox `assets.digital_product_linked|unlinked` once; `404 product_not_found` / `digital_link_not_found`
- [X] T054 [US5] Implement `AL/application/entitlement.service.ts` and `AL/infra/orders.consumer.ts` as S53 `Projector`s of `order.paid` / `order.refunded` (`orders.events`, `orderEventSchemas`): one entitlement per `(orderId, productId)` for lines whose product has a digital link and whose shop matches (quantity ignored, no retroactive grants); a refund revokes all entitlements of the order (full refund only); `AssetOrderRevocation` records refund-before-paid; idempotent; emit `assets.entitlement_granted|revoked` through the outbox; invalid payloads dead-lettered (D8, gaps A18, A20)
- [X] T055 [US5] Implement `AL/infra/catalog-shop.consumer.ts`: `catalog.product_deleted` (remove link once, event once, entitlements keep working, tolerate unknown product) and `tenancy.shop_deleted` (revoke entitlements with reason `shop_deleted`, mark assets for purge by the cleanup path, remove shares and links, duplicate no-op; gap A30)
- [X] T056 [US5] Implement the buyer side in `AL/application/digital.service.ts`, `AL/api/purchases.controller.ts` and `AL/api/digital.controller.ts`: my purchases (keyset `(grantedAt DESC, id)`, no revoked), buyer grant (`assets.grant.user` limit; entitlement checked at grant and at every fetch; uniform `404 entitlement_not_found`; opaque 192-bit grant with digest stored, 600 s, version-pinned; increments `downloadCount` and `lastDownloadAt`; `X-Licensed-To`), link routes with `products.write`; replace the `jwt_secret` JWT path (gap A19)
- [X] T057 [US5] Delete the `Product`, `BisOrder`, `BisOrderItem` SQL and the `jsonwebtoken` use from `AL/application/assets.service.ts` (remove the file once nothing references it); no `getOrderLines` call (S10 follow-up: events replace it, per `questions.md`); run `test-spec.sh digital-delivery` and `test-spec.sh digital-events` until green

---

## Phase 8: User Story 6 — Operators see it work and trust the jobs (P2)

**Goal**: metrics, log hygiene, once-only jobs, journal retention. Gaps A26, A27, A31; AS-73…AS-76.

**Independent Test**: `test-spec.sh asset-operations`.

- [X] T058 [US6] Create `AL/asset-operations.e2e-spec.ts` (describe "Asset library: metrics, logs and scheduled jobs"): AS-73 (registry counters, gauges, histograms after the flows), AS-74 (captured logs contain no token, presigned query or body; route template and `requestId` present for `/assets/shared/:token` and `/downloads/:token`), AS-75 (each of `assets.gc-chunks`, `assets.purge-deleted-assets`, `assets.purge-download-grants`, `assets.purge-changes` triggered twice with `Promise.all`: single effect, repeat no change), AS-76 (91-day vs 89-day entries, floor `minSeq` recorded, then `410 cursor_expired` for an old cursor — the only place this case is asserted)
- [X] T059 [US6] Wire metrics from `AL/application/asset-metrics.ts` into the upload, delivery, entitlement and cleanup paths (storage failures, stream aborts, entitlement lag histogram, hub publish failures, cleanup failures; gap A27)
- [X] T060 [US6] Declare the four jobs with `declareJobType` + `@JobHandler` in `AL/infra/assets.jobs.ts` (`assets.gc-chunks` hourly, `assets.purge-deleted-assets` daily, `assets.purge-download-grants` daily, `assets.purge-changes` daily advancing `AssetSyncState.minSeq`); schedules upserted by `AssetsWorkerModule`, replacing the `OnApplicationBootstrap` schedule (gap A31)
- [X] T061 [US6] Make request logging use route templates for the token routes so tokens never reach logs (the shared logging config change is already noted for S54 in `gaps.md`); run `test-spec.sh asset-operations` until green

---

## Phase 9: Access, replacement and close-out

- [X] T062 Create `AL/asset-access.e2e-spec.ts` (describe "Asset library: authorization and tenant isolation"): AS-19 (endpoint × anonymous/VIEWER/OWNER table; suspended and offboarding shop status gates), AS-20 (member of S2 on S1 paths → `404 shop_not_found`; S1 asset IDs under S2 on every asset route → `404 asset_not_found`; cross-shop link attempts `404`; no state change); fix any failing route (gap A24, SC-007)
- [X] T063 Delete `AL/assets.e2e-spec.ts` only after each of its five scenarios is covered by the new specs (L-017), removing its `BisOrderModel`/`BisOrderItemModel`/`ShopModel` imports (S10 follow-up, D-7); delete `AL/api/assets.controller.ts` when empty (gap A35)
- [X] T064 AS-79 gate: add a script assertion (e.g. `packages/backend/scripts/check-asset-library-no-fk.*`) that no migration of this capability declares a foreign key leaving the domain; `pnpm --dir packages/backend check:table-ownership --strict` must show no `asset-library` line (section C)
- [X] T065 [P] Confirm `gaps.md` "Sibling-spec follow-ups" (S10, S50, S54, S28, S03) is complete and add any new bullet as `- **<id>**: …`; `## Spec changes` stays "None" (no `*.reviewed.json`)
- [X] T066 [P] Ops artifacts: confirm `quickstart.md` "Ops artifacts" and `specs/UNVERIFIED.md` carry SC-001, SC-003, SC-004, SC-006, SC-008 as `not run` (already present; never call them verified); SC-002, SC-005, SC-007, SC-009 are proven by AS-24/29, AS-43/44, AS-19/20 and the problem-code assertions
- [X] T067 Finish `docs/spec/capabilities/S31-assets-digital-delivery.md` so every rule and behavior has a true `[proof: …]` / `[code: …]`; run `python3 scripts/livespec/check.py`
- [X] T068 Static gates: `pnpm exec tsc --noEmit` and ESLint in `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict`; `pnpm check:model-registry`; `pnpm check:module-graph`; confirm the count of direct `sequelize.transaction` sites in the domain did not rise and no `// S54 T037 audit` comment remains
- [X] T069 Run the whole capability suite once: `test-spec.sh libs/domains/asset-library` (standalone boots, fresh-stack and journey runs are deferred to the final checkpoint, not tasks)

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all stories). In Phase 2: T005–T009 before T010–T013; T016–T019 before T021; T020 before T021–T022; T025–T026 after T021–T024.
- US1 first (MVP). US2 builds on US1's commit path (T031) and journal; US3 on US1/US2 (versions, journal); US4 on US3 for the deleted/undeleted cases (AS-38, AS-53); US5 on US4's delivery service (T049); US6 on the job handlers (T044) and metric hooks.
- Within a story: e2e spec task → implementation tasks → run-until-green task.

## Parallel Opportunities

- T002–T004; T005–T009 then T010–T013; T021–T024; T065–T066.
- Spec-writing tasks of different stories (T034, T041, T046, T051, T052) can run in parallel after Phase 2; implementations share `upload.service.ts` and `library.service.ts`, so serialize those.

## Implementation Strategy

- **MVP**: Phases 1–3 (US1: prepare, commit, dedupe, quota, idempotency) with `test-spec.sh asset-upload` green.
- Then US2 → US3 (library integrity), US4 (share), US5 (digital delivery, which also pays D-7/D-12), US6 (operations), then Phase 9 close-out.
