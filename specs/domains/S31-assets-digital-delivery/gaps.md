# Gaps: S31 — current `asset-library` code versus the spec

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/asset-library/` unless stated; line numbers are those read on 2026-10-05. Section C was produced with `pnpm --dir packages/backend check:table-ownership` (run on 2026-10-05: 87 findings in 21 domains; `asset-library` has 3). Questions behind each row are in [`questions.md`](questions.md); scenario IDs refer to [`spec.md`](spec.md).

What exists: one service (`application/assets.service.ts`, 278 lines, all SQL inline), one controller (`api/assets.controller.ts`, 111 lines, 10 routes), a FastCDC chunker with a unit spec (`domain/fastcdc.ts`, `domain/fastcdc.spec.ts`), one e2e spec that calls services directly (`assets.e2e-spec.ts`, 5 tests), two migrations. There is no `infra/` folder, no repository, no port, no event, no consumer, no `packages/contracts` schema.

## A. Code versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Prepare counts a placeholder row younger than 1 hour as "already stored" without asking storage, so a never-uploaded chunk is skipped by the client and commit fails | `application/assets.service.ts:50` | FR-004, AS-05 |
| A2 | Prepare writes one `INSERT` per missing chunk outside a transaction; no quota; reused (already stored) chunks are not protected from cleanup; chunk size of an existing hash is not compared | `application/assets.service.ts:57-62` | FR-004–FR-006, AS-04, AS-14, AS-15, AS-42 |
| A3 | Chunk reference checks: hash regex only in service, `chunks` and `path` in `CommitDto` are `@IsString()` without the hash or path rules; prepare and commit caps are 10,000 (a 50 GiB file needs ~12,800); no file-size cap | `api/assets.controller.ts:16,20-24`, `application/assets.service.ts:46,77-78` | FR-001, FR-007, FR-008, AS-03, AS-09 |
| A4 | Commit has no `Idempotency-Key`; a retry after a lost response becomes a conflicted copy of itself | `api/assets.controller.ts:54-58`, `application/assets.service.ts:76-122` | FR-007, AS-12 |
| A5 | Storage `HEAD` is called while chunk rows are locked `FOR UPDATE` inside the transaction, sequentially for every unreferenced chunk (network I/O in a transaction, slow for 15,000 chunks) | `application/assets.service.ts:79-88` | FR-013, AS-16 |
| A6 | Semantic commit failures are `400`; no `unchanged` outcome; no `outcome` field; `size` is not `sizeBytes`; no storage timeouts or `503 storage_unavailable` | `application/assets.service.ts:77-90,120` | FR-009, FR-011, FR-014, AS-10, AS-13, AS-17 |
| A7 | Conflict decision uses `currentVersion !== baseVersion`, so a base from the future is treated like a stale one; the copy path is `INSERT … ON CONFLICT … DO UPDATE`, so a second conflict on the same device and day silently writes a new version into the first copy | `application/assets.service.ts:99-111` | FR-017–FR-019, AS-22, AS-27 |
| A8 | Conflict name uses `new Date()` (clock rule), has no collision numbering, and the naming logic is inline (not pure, not unit-tested) | `application/assets.service.ts:101-103` | FR-018, FR-049, FR-055, AS-23 |
| A9 | Edit-versus-delete: lookup is `NOT deleted`, so a stale edit of a deleted file creates a new asset, but nothing asserts it and `created` is not an outcome | `application/assets.service.ts:92-96,106-111` | FR-019, AS-26 |
| A10 | No version cap; no empty-file rule (empty chunk list is refused with `400`) | `application/assets.service.ts:78` | FR-012, FR-015, AS-11, AS-45 |
| A11 | `deleteVersion` deletes any version including the current one, then tombstones the asset while older versions remain, journals `delete` with the removed version number, and has no `409`; no asset delete, undelete, restore or purge exist | `application/assets.service.ts:125-138`, `api/assets.controller.ts:72-77` | FR-026–FR-029, AS-35–AS-40 |
| A12 | Journal: numeric cursor, junk becomes `0`, no `limit` parameter, no retention, no floor, no `cursor_expired`, response shape `{changes, cursor, hasMore}`; no asset listing and no `syncCursor` | `application/assets.service.ts:141-148`, `api/assets.controller.ts:60-64` | FR-020–FR-022, AS-28–AS-31, AS-76 |
| A13 | Manifest presigns every chunk of a version in one response, serves deleted assets (`version()` does not check `deleted`), and parses `version` with an unchecked `Number()` | `application/assets.service.ts:151-155,247-255`, `api/assets.controller.ts:67-70` | FR-023, AS-32 |
| A14 | Streaming: headers and `Content-Length` are sent before any chunk is opened, errors only `destroy` the body (no uniform `503`, no timeouts, no metric), `file.body.pipe(res)` has no error handler, deleted assets still stream | `application/assets.service.ts:158-172`, `api/assets.controller.ts:32-40` | FR-014, FR-037, AS-57 |
| A15 | `Content-Disposition` uses `encodeURIComponent` inside `filename="…"` (no `filename*`, wrong escaping), no `Referrer-Policy` | `api/assets.controller.ts:32-35` | FR-037, AS-55, AS-56 |
| A16 | Share link: expiry silently clamped to 720 hours, `maxDownloads` has no upper bound, response lacks `id`/`expiresAt`, no list, no revoke, link row has no `id`, `createdBy` or `revokedAt`, URL is built on `backend_host` (same origin as the API), asset deleted check missing (`version()` ignores `deleted`) | `application/assets.service.ts:175-182`, `api/assets.controller.ts:27-30,79-83` | FR-032, FR-033, AS-46, AS-47, AS-52 |
| A17 | Redeem is a `GET` that increments `downloads` before checking the asset, so a link on a deleted asset is consumed and then fails; link scanners burn capped links; no rate limit | `application/assets.service.ts:185-192`, `api/assets.controller.ts:92-96` | FR-034, FR-046, AS-48–AS-53, AS-58 |
| A18 | Digital entitlement is a join over `BisOrder` and `BisOrderItem` with a status list; `403` when not purchased | `application/assets.service.ts:199-207` | FR-040, FR-042, AS-61, AS-68 |
| A19 | Buyer token is a JWT signed with the session secret (`jwt_secret`), default `jsonwebtoken` verification (no pinned `alg`, `iss`, `aud`), redeemed anonymously with no entitlement re-check, so a refunded buyer's URL keeps working; no revocation, no counter, no list of purchases | `application/assets.service.ts:208,212-221`, `api/assets.controller.ts:98-110` | FR-036, FR-041, FR-042, FR-043, AS-64, AS-66, AS-67, AS-69 |
| A20 | No consumer of `order.paid` or `order.refunded`, no outbox use, no events at all | `assets.module.ts:10` (no outbox or consumer import) | FR-040, FR-041, FR-047, FR-048, AS-61–AS-65 |
| A21 | `linkDigitalProduct`: product check is SQL joining `Product` and `Asset`; only `PUT` exists (no read, unlink, re-link of entitlements, sold-product guard, `asset_in_use` guard, event); asset not checked for `deleted` | `application/assets.service.ts:238-245`, `api/assets.controller.ts:85-90` | FR-028, FR-039, FR-054, AS-38, AS-59, AS-60 |
| A22 | Cleanup deletes the row first and swallows object-delete errors (orphaned objects, no metric); no protection for chunks reused by prepare or racing a commit; `GC_GRACE` is interpolated into SQL text; only hourly schedule exists, no purge jobs | `application/assets.service.ts:223-236`, `assets.module.ts:18` | FR-031, FR-050, AS-41–AS-43, AS-75 |
| A23 | Time is `now()` in SQL and `new Date()` in code in six places (prepare, share create/redeem, conflict name, cleanup) | `application/assets.service.ts:50,59,102,178,187,229` | FR-049, AS-41, AS-51 |
| A24 | `version()` takes an optional `shopId`; callers that pass none read unscoped (used for tokens, which is intended, but the optional parameter is a record-level security footgun) | `application/assets.service.ts:247-251` | FR-045, AS-20 |
| A25 | No realtime notification after journaled changes | absent | FR-024, AS-33 |
| A26 | No rate limits on any route; no `429` | `api/assets.controller.ts` (absent) | FR-046, AS-18, AS-58, AS-72 |
| A27 | No metrics, no structured failure counters; share and download tokens are in URL paths and would appear in default access logs | absent | FR-051, AS-73, AS-74 |
| A28 | No schemas in `packages/contracts` (V.2), no response DTOs (V.1: the service returns bare objects), no problem+json `code`s | whole domain | FR-053, VII.6 |
| A29 | No per-shop storage quota or usage accounting | absent | FR-006, AS-14, AS-15 |
| A30 | No reaction to `catalog.product_deleted` or `tenancy.shop_deleted` | absent | FR-044, AS-70, AS-71 |
| A31 | `AssetsWorkerModule` provides the whole `AssetsService` (HTTP-facing code) just for one job; the schedule is an in-module `OnApplicationBootstrap` | `assets.module.ts:22-24,13-20` | FR-050, D-6 |
| A32 | The FastCDC unit spec covers 3 cases and no property tests, empty input or short input | `domain/fastcdc.spec.ts:1-34` | FR-016, AS-77 |
| A33 | SD-25 says a reference CLI `scripts/asset-sync-cli.ts` exists; it does not. The spec only requires the pure chunker and a test helper | `docs/showcase/sections/SD-25-seller-media-library.md` | Assumptions |
| A34 | Pure rules (path validation, conflict naming, content-disposition, reference-count planning) are inline in the service | `application/assets.service.ts:77,101-103` | FR-055, AS-23, AS-56, AS-78 |
| A35 | The e2e spec calls `AssetsService` methods directly (no HTTP, no guards, no filter), seeds orders through `BisOrderModel`/`BisOrderItemModel`/`ShopModel`, ages chunks by raw SQL, and has none of the VII.3 cases (401, IDOR, validation, idempotency, rate limit, concurrency) | `assets.e2e-spec.ts:12-13,18,50,99,132-133` | VII.2, VII.3, test-plan |

## B. Schema and migrations

Existing: `migrations/20261002110000-asset-library.js`, `migrations/20261003090000-asset-path-check.js`; ownership registry `db/ownership.ts:158-164` (7 tables, all `domain:asset-library`). Every change below is expand/contract with `lock_timeout` (III.11).

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Foreign keys `Asset.shopId → Shop` and `DigitalProduct.productId → Product ON DELETE CASCADE` cross owners (IX.4: references are plain IDs); drop them. The product-delete cascade is replaced by the `catalog.product_deleted` consumer | `migrations/20261002110000-asset-library.js:14,64` | FR-054, FR-044, AS-70, AS-79 |
| B2 | `Asset` lacks `deletedAt` (the undelete window and purge need it) | same file `:12-19` | FR-028, FR-029, AS-39, AS-40 |
| B3 | `AssetShareLink` lacks `id`, `createdBy`, `createdAt`, `revokedAt`; token digest is the PK | same file `:55-61` | FR-032, AS-46, AS-52 |
| B4 | New owned tables (register each in `db/ownership.ts` and `domain-map.md` in the same PR, IX.3): entitlements (unique on order and product, status, reason, title copy, counters), download grants (digest, kind, asset, version, link or entitlement, expiry), shop storage usage (stored and reserved bytes, quota check by conditional update), order revocation records (order, version); index choices are the plan's | absent | FR-006, FR-036, FR-040, FR-041, AS-14, AS-64, AS-65 |
| B5 | `AssetChange` has no retention floor record and no index for the purge by `at`; `AssetSyncState` may carry the floor | same file `:43-53` | FR-021, AS-76 |
| B6 | Chunk rows have no way to record "confirmed in storage" or "grace restarted at"; `unreferencedSince` serves both today | same file `:33-41` | FR-004, FR-031, AS-05, AS-42 |
| B7 | Keyset indexes for the listing (`shopId`, `path`, `id` on live rows already partly there), versions (`assetId`, `version desc`), purchases (`buyerId`, `grantedAt desc`, `id`) | same file / new | FR-022, FR-025, FR-042 |
| B8 | `AssetVersion.chunks TEXT[]` for up to 15,000 hashes works but makes "who references this chunk" a scan; the refcount-exactness invariant (AS-44) and cleanup (AS-43) need a design decision in `plan.md` (per-version chunk rows or keep the array and rely on the counter) | same file `:22-31` | FR-030, AS-44 |

## C. `check:table-ownership` lines for `asset-library` (cross-domain access; debt D-7 and D-12)

Output on 2026-10-05:

```
asset-library  (3)
  SQL   Product      owned by catalog   libs/domains/asset-library/application/assets.service.ts
  SQL   BisOrder     owned by orders    libs/domains/asset-library/application/assets.service.ts
  SQL   BisOrderItem owned by orders    libs/domains/asset-library/application/assets.service.ts
```

| Finding | Where | Replacement (IX.7) |
|---|---|---|
| SQL `Product` (product-in-shop check joined with `Asset`) | `application/assets.service.ts:239` | **R1**: `ProductQueryService.getProductsByIds([productId], { shopId })` from `@app/domains/catalog` (S05); the asset-in-shop check stays an own-table query |
| SQL `BisOrder`, `BisOrderItem` (entitlement join) | `application/assets.service.ts:201-205` | **R3**: consume `order.paid` and `order.refunded` from `orders.events`, store entitlements in this domain's own table; no call to `OrderQueryService.getOrderLines` (see `questions.md`, CONTRACT) |
| Models `BisOrderModel`, `BisOrderItemModel`, `ShopModel` in the e2e spec (not in `check:table-ownership` output because it is a spec, D-7 in spirit) | `assets.e2e-spec.ts:12-13,18` | Replace by contract-valid event delivery and the S03 and S05 fixtures |
| Foreign keys to `Shop` and `Product` (not reported by the tool) | `migrations/20261002110000-asset-library.js:14,64` | Drop (B1); IDs only |

After this capability: `pnpm --dir packages/backend check:table-ownership --strict` shows no `asset-library` line, and S10 can drop `BisOrderModel` and `BisOrderItemModel` from its barrel once S13, S16, S21, S31, S42 and S43 have migrated (S10 `gaps.md` D-7 row).

## D. Open debt-register rows that name `asset-library` or S31

The register (`docs/architecture/debt-register.md`) has no row that names `asset-library` or `S31` explicitly. Rows that apply to this domain through "every capability of the domain" or through the consuming-domain rule:

| Row | Applies how | Paid by | Mechanism |
|---|---|---|---|
| D-6 (I.2 layering) | `application/assets.service.ts` imports `@nestjs/sequelize`, `sequelize` (`QueryTypes`, `Transaction`), `ObjectStorage` (infra), `jsonwebtoken`; `api/` is fine; there is no `domain/` port or `infra/` adapter besides the chunker | S31 | Introduce repository and storage ports in `domain/` with tokens, adapters in `infra/` (asset repository, chunk repository, journal, share, entitlement, grant), application services orchestrate and open transactions; pure rules in `domain/` (FR-055) |
| D-7 (IX.4 model imports) | Consumes `BisOrderModel` (e2e spec only) | S31 | R3 (events into an own entitlement table) |
| D-12 (IX.4 raw SQL on other owners) | 3 findings, section C | S31 | R1 for the product lookup, R3 for orders |
| D-8 (X.4 barrel exports) | `index.ts` exports only `AssetsModule` and `AssetsWorkerModule`, no internals; already compliant | none | Keep the barrel to the two modules (spec: Provides) |

Not applicable: D-10, D-11, D-14, D-15, D-16, D-17 (other domains); D-1..D-5, D-9, D-13 are resolved.

## E. Static gates the implementation must keep green

- `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`.
- `pnpm --dir packages/backend check:boundaries` (X.4, X.5): the domain imports only other domains' entry points (`@app/domains/identity`, `@app/domains/tenancy`, `@app/domains/catalog` for the R1 service, event contracts), `@app/infrastructure/*` and `@app/common/*`.
- `pnpm --dir packages/backend check:table-ownership --strict` (AS-79).
- `pnpm --dir packages/backend check:model-registry` and `check:module-graph`: the new worker module's models and consumers resolve in the `worker` app.

## F. Suggested order of work

1. Migration (B1–B8) and the ownership registry; pure domain logic with unit specs (path rules, conflict naming, content-disposition, chunk-reference planner, FastCDC properties): A3, A8, A32, A34.
2. Ports and adapters (D-6), contracts schemas (A28), prepare, commit, idempotency, quota, storage timeouts: A1–A6, A10, A23, A29.
3. Conflicts, journal, listing, manifest, notification: A7, A9, A12, A13, A25.
4. Versions, delete, undelete, restore, purge, cleanup safety: A11, A22.
5. Share links and download delivery: A14–A17, A26.
6. Digital products and consumers: A18–A21, A30, then drop the product and order SQL (section C).
7. Rate limits, metrics, logs, jobs, worker module split: A26, A27, A31; rewrite the e2e specs (A35) as each area lands, and update `domain-map.md` (CONTRACT question).
