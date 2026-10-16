# Research: S31 design decisions (Phase 0)

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted. This file settles the three decisions the spec hands to the plan (gaps B8, the cleanup-versus-commit mechanism, storage layout) and the toolkit choices. Paths are under `packages/backend/libs/`.

## D1. Chunk references: per-version chunk rows, not only the array

- **Decision**: keep `AssetVersion.chunks TEXT[]` as the ordered list (manifest, equality test for `unchanged`) and add `AssetVersionChunk(assetId, version, hash, occurrences)` with one row per *distinct* hash of a version (index on `(shopId, hash)`). `AssetChunk.refCount` is changed in the same transaction as the version rows, by `occurrences`, and `AssetVersionChunk` is the audit source: "who references chunk h" is an index lookup, and the invariant test (AS-44) compares `refCount` with `SUM(occurrences)`.
- **Rationale**: a 15,000-entry array makes "who references h" a scan; per-distinct-hash rows are at most 15,000 per version and written with one multi-row `INSERT … SELECT unnest`. The counter stays the fast path for cleanup.
- **Alternatives**: array only plus counter (cannot be verified or repaired); one row per position (15,000 rows with repeats, no gain).

## D2. Cleanup versus commit versus reuse: generations without locks held over storage

- **Decision**: `AssetChunk` gets `storedAt` (set only after storage confirms the object) and `protectedUntil` (set to `now + 24 h` by every prepare that reports the chunk stored, and by every commit that references it). Cleanup selects candidates `refCount = 0 AND protectedUntil < now AND unreferencedSince < now − 24 h` (with `FOR UPDATE SKIP LOCKED` in a short transaction that only *claims* them by setting `deleting = true`), commits, then deletes the object (storage call outside any transaction), then deletes the row with `WHERE deleting AND refCount = 0`. Commit and prepare lock the chunk rows (`FOR UPDATE`, sorted by hash) in their own transaction and, if a row is `deleting`, treat the chunk as not uploaded (`422 chunk_not_uploaded`; prepare answers it `missing` and clears `deleting` only after a fresh `storedAt`). A claim that failed object deletion is released (`deleting = false`) and counted.
- **Rationale**: FR-013 forbids storage calls inside a transaction; FR-031 forbids a committed version pointing at a missing object. Claim-then-delete makes the race outcomes exactly the two the spec allows (AS-43). `protectedUntil` implements FR-004 (24 h further protection) and AS-42.
- **Alternatives**: advisory lock held across the storage delete (holds a connection during network I/O); delete row first (orphans objects, A22).

## D3. Storage presence check before the transaction, re-validated inside

Commit: (1) validate and read chunk rows (no lock), (2) `head` every chunk not confirmed by `storedAt` recently with bounded concurrency (16) and 5 s timeout, outside any transaction, recording `storedAt`, (3) open the transaction, lock the asset row then chunk rows, require `storedAt IS NOT NULL AND NOT deleting`, apply. `storedAt` older than the grace is not trusted blindly: a chunk with `protectedUntil < now` is re-`head`ed in step 2. AS-16 test gate sits inside the adapter's `head`.

## D4. Journal numbering

`AssetSyncState.lastSeq` is bumped with `UPDATE … SET lastSeq = lastSeq + 1 RETURNING` inside the commit transaction after the asset lock; the row lock serialises writers per shop so numbers are gapless and in commit order (AS-29). Reads use `seq <= (SELECT lastSeq)`, which is safe because a number is visible only once its transaction committed (the counter row lock is held to commit). Retention floor: `AssetSyncState.minSeq` set by `assets.purge-changes` to the first retained `seq − 1`; cursor `< minSeq` → `410`. The cursor is `base64url("v1:" + seq)`.

## D5. Quota

`ShopStorageUsage(shopId, storedBytes, reservedBytes)`. Prepare reserves with one conditional update `SET reservedBytes = reservedBytes + $n WHERE storedBytes + reservedBytes + $n <= $quota RETURNING` (atomic under concurrency, AS-15); the new chunk rows are inserted with `reserved = true` in the same transaction. A chunk becoming confirmed (`storedAt`) moves its size from reserved to stored (done by whichever of prepare-retry or commit confirms it); cleanup subtracts stored bytes of deleted rows; a reservation whose chunk was never uploaded is released by cleanup after the 24 h grace together with its placeholder row. A repeated prepare for a chunk that already has a reserved placeholder reserves nothing again.

## D6. Idempotent commit

Use the S54 idempotency facility (`@Idempotent`, `IdempotencyRepository`), key scope `(shopId, userId)`, TTL 24 h; the interceptor already gives replay header, in-flight `409`, reuse `422`. The pipeline order is: guard → rate limit → validation → idempotency → handler (the missing/malformed key codes are mapped to `idempotency_key_required|invalid`). Check at implementation time that the facility's codes match AS-09 and record a bridge in the controller if they differ.

## D7. Download delivery and tokens

Grants are opaque 24-byte random tokens (base64url), only `sha256` stored (`DownloadGrant`). `GET /downloads/:token` re-checks grant expiry, link (not revoked, not expired is **not** re-checked for share: the grant lives 120 s independently, per AS-49) or entitlement `ACTIVE`, and asset not `PURGED`; it opens the first chunk before sending headers (`503` otherwise), streams with `pipeline()` and `Readable.from` over an async generator with an idle timeout of 30 s; a later failure destroys the socket. File name header from a pure function (`content-disposition.ts`). The anonymous routes are `@Firewall({anonymous: true})`, rate limited `assets.redeem.ip` (fail open), and excluded from path-parameter logging (route templates only, AS-74).

## D8. Entitlements and events

Two `Projector` consumers (S53 toolkit, as `seller-onboarding/infra/shop-deleted.consumer.ts`) registered through `AssetsProjectorModule.projectors`: `orders` (handles `OrderPaid`, `OrderRefunded`), and `shop+product` (handles `ShopDeleted`, `ProductDeleted`). Idempotency `inbox` for orders (the work is DB-only inside one transaction with the outbox append); `natural` for the shop consumer (storage deletes happen later in the purge job). Order revocation record `AssetOrderRevocation(orderId, orderVersion)`: `order.refunded` upserts it (max version) in the same transaction that revokes; `order.paid` first checks it (revocation version > paid version, or any revocation, since refund is terminal) and grants nothing.

## D9. Realtime

`RealtimePublisher` (infrastructure/realtime) after commit, wrapped in try/catch, counter `assets_realtime_publish_failures_total`. The route `shop:<id>:assets` (`api/realtime-topics.ts`, `AssetTopicsModule`) already exists (S51 follow-up done); it gets a unit/e2e assertion only, and the module keeps being imported by the gateway. Whether `TopicRegistry.define` form is final is verified, not changed.

## D10. Rate limits and config

`definePolicies('asset-library', {...})` in `rate-limit-policies.ts` (pattern of `seller-onboarding`), checked in services; `assets.upload.shop` 120/min closed, `assets.redeem.ip` 60/min open, `assets.grant.user` 30/min closed. Config keys `usercontent_origin` (S54; production check equals app origin), `assets_quota_bytes`, `assets_version_cap`, `assets_undelete_days`, `assets_journal_days`, `assets_gc_grace_hours` with the defaults of the spec, validated at boot like `EXTRACTION_CONFIG`.

## D11. Transactions

All transactions via `TransactionRunner.run` / `@Transactional`; the existing service has direct `sequelize.transaction` sites with `// S54 T037 audit` comments: each is migrated and its comment deleted as the file is rewritten. No new direct site.

## D12. Layering (D-6)

`domain/` (pure rules, ports with injection tokens, errors), `infra/` (Sequelize repositories, storage adapter wrapper with timeouts, consumers, jobs), `application/` (services own transactions), `api/` (controllers, zod DTO pipes as `seller-onboarding/api/zod.pipes.ts`, response schemas from `packages/contracts`). Barrel exports only `AssetsModule`, `AssetsWorkerModule`, `AssetsProjectorModule`, `AssetTopicsModule`.

## D13. Sibling follow-ups, requirements from earlier specs

- S05 `getProductsByIds([id], {shopId})` replaces the product SQL (R1). S10's follow-up says "use `getOrderLines`"; the accepted `questions.md` CONTRACT decision is events (R3) and removes the SQL either way, so the follow-up's goal (no `BisOrder*` SQL, no `BisOrderModel` in the spec) is met; the call itself is not made and `gaps.md` records it for S10.
- S51: the topic is registered through `TopicRegistry.define` (already in place); the plan keeps it and adds the publish.
