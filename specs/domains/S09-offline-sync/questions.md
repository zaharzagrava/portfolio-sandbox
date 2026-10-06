# Open Decisions for S09 (answered unattended)

Format: `[TAG] question → default taken → why`. BREAKING first, then CONTRACT, then LOCAL. The human reviews BREAKING and CONTRACT lines first. Decision policy: most production-grade option the Interview-Prep notes and the constitution support; no external clients to keep compatible, so correctness, security, observability and clean domain boundaries win over preserving today's behaviour.

## BREAKING (changes behaviour or an API/UI contract that exists today)

- [BREAKING] Product and stock writes (today raw `UPDATE "Product" … quantity = quantity + :delta` and `SET "title" = …` plus raw outbox rows `{productId}`, `sync.service.ts:84,101,128`) → stock only through S05's `applyStockDelta` (deterministic operation ID `sync:<shopId>:<opId>`), fields only through S05's `ProductCommandService.update`; this domain writes no product row and no product event → constitution IX.4, domain-map ("never writes `Product` directly"), S05 questions line "S07, S08, S09 write only through …".
- [BREAKING] Change feed filled by a database trigger on the catalog's table (migration `20261001360000-offline-sync`) → filled by a projector consuming `catalog.product_*` events (read model, IX.7 R3, IX.8 copies with `productVersion`); the trigger and the foreign key from `ProductFieldClock` to the product table are dropped → IX.4 bans triggers and foreign keys across owners; the price is a few seconds of feed lag (stated: 5 s p99).
- [BREAKING] Negative stock (today applied and flagged "oversold", quantity can be −1) → never below zero: the available part is applied, the shortfall is an `oversold` conflict → S05's invariant (III.6, "never below zero") holds in the catalog; a negative stock would be rejected there anyway.
- [BREAKING] Idempotency key (today global `opId` primary key, replay answers `duplicate` with no outcome) → unique per `(shopId, opId)`, content fingerprint, replay returns the original outcome with `replayed: true`, same ID with different content is `op_id_reused`, `opId` must be UUIDv7 → V.6 semantics (replay returns the stored result, key misuse is refused), no cross-tenant existence leak, note 10/04 §6 ("UUIDv7 IDs, idempotent by operation ID").
- [BREAKING] One invalid operation fails the whole push with `400` (today) → per-operation `rejected` with a stable code and `index`; only envelope errors fail the request → a poison operation must not strand every later sale on a device queue (note 10/04 §6 "outbox of local mutations").
- [BREAKING] Result vocabulary (today `applied | merged | duplicate | conflict | rejected` with free-text `detail.reason`) → `applied | merged | conflict | rejected | retry` plus `replayed` and a closed list of `code`s → clients branch on codes, not strings.
- [BREAKING] Clock plausibility rejects every operation with a clock > 60 s ahead (today) → only `product.update` (clock-ordered) is rejected; stock deltas commute and are applied → rejecting a real sale because a till's clock is fast loses money; the clock cannot change the result of a delta.
- [BREAKING] Field edit wire name `price` (integer, unnamed unit) → `priceMinor` → aligns with S05's `priceMinor`; constitution III.8 (integer minor units, named).
- [BREAKING] Pull cursor (today a number parsed with `Number(x) || 0`, garbage becomes 0, no limit validation) → opaque cursor bound to shop and feed generation; malformed `400 invalid_cursor`, bad `limit` `400 validation_failed`, stale `410 resync_required`; entries gain `version` and `deleted`; a pull without cursor is the bootstrap → III.10 (opaque cursors), note 06/02 §6 (commit-ordered sequence), no silent restart from zero.
- [BREAKING] Max operation age and retention (today none; operation records kept forever, replays always safe because the table is never purged) → operations older than 30 days by clock are `op_expired`, records kept 90 days, purge job → bounded storage with a replay guarantee; the catalog's own stock-operation memory is 30 days.
- [BREAKING] `X-Device-Id` required on pull too, and the clock's node part must equal it (today push only, any node accepted) → per-device rate limits and attribution; the node tie-break only makes sense if the node identifies the device.
- [BREAKING] `GET …/sync/conflicts` (today a bare array of the last 200 `conflict` operation rows, no state, no dismissal) → `{items, nextCursor}` with `status`, plus `POST …/conflicts/:opId/dismiss` (`products.write`, once, `409 conflict_not_open`) → note SD-06 "conflict list for review"; a list nobody can close is a log, not a queue (P0612).
- [BREAKING] Rate limit on push (today the unrelated policy `search.query`, none on pull) → `catalog-sync.sync-push.device`, `…sync-pull.device`, `…conflict-write.shop`, fail closed → note SD-06 scale target (store-opening bursts) and 04-API-Design/03.
- [BREAKING] Time and clocks (today `Date.now()` in the service, one in-memory server clock) → injected clock; the server clock per instance is monotonic and only a hint for devices; request body capped at 2 MiB (`413`) and a 20 s per-push budget with `retry` / `deadline_exceeded` → constitution IV.6 (timeouts), VII.2 (frozen time).
- [BREAKING] `OfflineSyncModule` exports `SyncService`; the spec module also injects `ShopModel` / `ProductModel` in its e2e → nothing but the module is exported; tests read products through the catalog's exported query service → X.4, D-7.
- [BREAKING] Field-clock table: foreign key to the product table with cascade delete, no shop → add `shopId`, no foreign key, rows removed on `catalog.product_deleted` and `tenancy.shop_deleted` → IX.4, privacy purge.
- [BREAKING] The change feed has no retention (today unbounded) → compaction (30 days; newest per product and young tombstones kept) with `410 resync_required` beyond the horizon → bounded growth with an explicit resync instead of silent holes.

## CONTRACT (decides something another capability must provide or consume)

- [CONTRACT] S05 lists `ProductImportService.upsertFromExternal(…, 'offline')` as S09's write path → S09 does **not** use it (it requires `externalSku` and a full item; a device edits single fields of a known product); S09 uses `ProductCommandService.update` for fields and `applyStockDelta` for stock → S05 should add S09 as consumer of `update` and `listByShop` and may drop the `'offline'` source value.
- [CONTRACT] S05 `ProductCommandService.update` must throw a typed validation error with field codes (`ProductValidationError {errors: {field, code}[]}`) → S09 turns it into `rejected` / `invalid_field` without parsing messages.
- [CONTRACT] Clamping an oversold delta needs the current quantity → S09 reads it with `getProductsByIds(ids, {shopId})` and issues a second `applyStockDelta` with operation ID `…:clamp` (at most 3 attempts on a race) → S05's all-or-nothing contract stays unchanged; asking S05 for a "clamp at zero" mode was rejected as it would weaken its invariant API.
- [CONTRACT] S05 events as the feed's source: `catalog.product_*` payloads must carry `shopId`, `title`, `description`, `priceMinor`, `currency`, `quantity`, `status`, `productVersion` (copy rule IX.8) → matches S05's declared payload; no read of the product table.
- [CONTRACT] S05 must keep the same `productVersion` guarantee (increases with every change) → the feed's duplicate and out-of-order guard compares it.
- [CONTRACT] S08 → needs nothing from S09; S09 changes stock only through `applyStockDelta`, so S08's outbound push (S08 AS-36) covers offline sales; no S09 → S08 call → S08 questions line for S09.
- [CONTRACT] S07 → the event topic `catalog-sync.events` is shared; S09 adds `catalog_sync.offline_conflict_opened` v1, key `opId` → S07 asked that the topic stays one per domain.
- [CONTRACT] S03 `tenancy.shop_offboarding_started` → S09 declines to export its data (operations, feed, clocks are operational data derived from products, which S05 exports); on `tenancy.shop_deleted` it purges → S03 FR-062 purge contract; the offboarding gate already blocks pushes (`409 shop_offboarding`).
- [CONTRACT] S50 → three policies registered under the names in `spec.md` (fail closed, `429` with `Retry-After`, per device and shop) → S50 owns the registry.
- [CONTRACT] S49 → three jobs (`catalog-sync.redrive-stale-ops`, `…compact-change-log`, `…purge-sync-operations`) single-run with leases → S49.
- [CONTRACT] S53 → consumers use the framework's envelope check, zod validation, version guard, DLQ; `outbox.append` in this domain's transaction → IV.4, IV.5, IX.6.
- [CONTRACT] S54 → injectable clock honoured by the e2e harness (frozen time), `code` on problem+json, request context carries `requestId` → VII.2.
- [CONTRACT] W04 / device app → conflict review screen and the device client are not specified here; the routes and schemas in `spec.md` are the whole contract; no UI journey for S09 exists until the device app (phase 2) does → SD-06 "FE (PWA, IndexedDB, Service Worker) = phase 2".
- [CONTRACT] J04 → step "an offline store device sells stock" is proven by AS-01 (push) and AS-52 (stock only through the catalog), then S05's event reaches S32, S19 and S08 → journeys read only HTTP and events.

## LOCAL (affects only this capability's internals)

- [LOCAL] Operation type names (`stock.adjust`, `stock.count`, `product.update`) kept instead of the notes' `{entity, op, payload, baseVersion}` → same information; `base` of a count is the version-free analogue of `baseVersion`; fields use clocks, not versions.
- [LOCAL] `baseVersion` on `product.update` → not sent; clocks decide per field.
- [LOCAL] Superseded field edits are not conflicts → LWW is the stated policy; the loss is reported in the result and kept in the record.
- [LOCAL] No device registry, no per-operation signature → attribution by session and `X-Device-Id` at push time; permission checked at push time (a removed member cannot push).
- [LOCAL] No offline product creation → devices only operate on pulled products.
- [LOCAL] Result of a half-finished operation → claim row is committed first, the catalog call carries a deterministic ID, the result is recorded afterwards; completion is safe to repeat; claim lease 60 s, recovery job after 5 min.
- [LOCAL] Per-product serialization of field decisions → a lock keyed by product; the catalog call stays outside any open transaction of this domain.
- [LOCAL] Field-edit race with the seller → bounded retry (3) on the catalog's version conflict, then `retry` with code `contention` (not `rejected`) → the operation stays recoverable by a resend.
- [LOCAL] Push order → operations processed strictly in request order; no cross-request ordering promise (commutativity makes it unnecessary for stock, clocks for fields).
- [LOCAL] Pull default `limit` 200, max 500 → keeps pages small enough for mobile links.
- [LOCAL] Feed rebuild for shops that already have products → one-off backfill through S05's `listByShop` plus a new feed generation (all old cursors get `410`).
- [LOCAL] Numbers (500 ops, 2 MiB, 20 s, 60 s lease, 5 min recovery, 60 s drift, 30 d, 90 d, rate budgets) → configuration validated at startup, not contract.
- [LOCAL] Dismissed conflicts follow their operation's 90-day retention; open ones are kept.
- [LOCAL] No `Idempotency-Key` header on push → per-operation IDs are the key (V.6 lists money and booking creations only).
