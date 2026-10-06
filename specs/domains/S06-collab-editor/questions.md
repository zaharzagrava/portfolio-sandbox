# Questions and defaults: S06 — Collaborative listing drafts

No question was asked (unattended run). Each line is a choice made under the decision policy (most production-grade option the notes and constitution support), sorted by impact: BREAKING, then CONTRACT, then LOCAL.

## BREAKING

- [BREAKING] Other-shop draft: `assertShop` loads by id then answers `403` → `404 draft_not_found` with the shop in every predicate; non-member `404 shop_not_found` → III.4 and V.4 forbid load-then-check and require 404 for cross-tenant; update the e2e and callers.
- [BREAKING] Membership and permission: `SELECT … "ShopMembership"` and `role !== 'VIEWER'` → `ShopScoped('products.read'|'products.write')` on every route plus R1 `ShopAccessService.assertMember` for tickets (write = holds `products.write`); connect loses `@Firewall()` → IX.4 (D-7/D-12), and a permission, not a role name, is the notes' "viewer vs editor".
- [BREAKING] Publish write path: raw `UPDATE "Product"`, own outbox row and `ProductService.create` → `ProductCommandService.create/update` with `expectedVersion` (in the draft's transaction) → S05's contract (A23), one write path keeps version, history and events consistent.
- [BREAKING] Lost-update guard: publish overwrote the product blindly → the draft records `baseProductVersion`; publish with a newer product version is `409 product_version_conflict` unless the publisher sends `acknowledgeProductVersion` → collaborative edits must not silently erase seller changes made elsewhere (S05, S07, S09 also write products).
- [BREAKING] Publish protocol: single unguarded read-then-write returning `{productId}` and `400` on repeat → `Idempotency-Key` required, `DRAFT → PUBLISHING → PUBLISHED` lease claim, freeze point, one transaction, response `{productId, productVersion, versionId}`, `409 invalid_transition` for a published draft → exactly-once publish; notes: "publish = snapshot → product revision via outbox".
- [BREAKING] Schema of the tables: `ListingDraft` and `ListingDraftVersion` reference `Shop`, `Product` and `User` with foreign keys → drop them (plain ids), add `baseProductVersion`, `publishLeaseId`, `publishLeaseExpiresAt`, `kind` on versions, status `PUBLISHING`, unique-open-draft counting by constraint-safe update; expand/contract migration with `lock_timeout` → IX.4 forbids cross-owner FKs, III.11.
- [BREAKING] Document key `fields.price` → `fields.priceMinor` (integer minor units; non-integer values are `listing_invalid`); no data migration → money is integer minor units (III.8) and S05 names it `priceMinor`; there is no production data.
- [BREAKING] Ticket: signed with the shared session secret, no `alg` pin, no issuer/audience, reusable for 60 s, `?ticket=` may reach logs → dedicated key, pinned algorithm, `iss`/`aud`/`jti`, single use (consumed only by a successful join), `Origin` allowlist, query redacted from logs → VIII.7 and notes' "access tokens in URLs end up in logs".
- [BREAKING] Read-only writes: silently dropped → dropped, answered with a permission-denied message, counted and logged; ability is rechecked per update from current membership, and `DraftsService.revoke` (never called today) is replaced by event consumers plus a 60 s batched re-check → notes: "permissions on join and on each operation; revoke = kick".
- [BREAKING] Store failure handling: any log-append error marked the room failed, closed sockets `4002` and dropped the batch already taken from `pending` → retry with backoff, keep pending, identical-bytes conflict is success, only a true conflict evicts; writers are cut at 8 MiB / 30 s backlog (`4013`) → no silent data loss.
- [BREAKING] Unload race: `RoomManager.unload` removes the room before its flush finishes, so a concurrent join can load stale state and conflict → a join waits for an in-flight unload.
- [BREAKING] Version responses: `createVersion` returned `{id, name, content}`, `versions` returned raw rows → `draftVersionSchema` (no content) for create/list, content only in `GET …/versions/:versionId`, keyset paging, 200 per draft.
- [BREAKING] Draft list: `ORDER BY "updatedAt" DESC LIMIT 100`, raw rows → keyset page `{items, nextCursor}` with `draftSchema` views (III.10, V.1).
- [BREAKING] Errors: Nest `BadRequestException`/`ForbiddenException` with free text → problem+json with the codes of the contract (V.3).
- [BREAKING] New limits and close codes: 2 MiB document, 200 frames/s, 5 connections per user, 8 KiB presence, `4005`, `4009`, `4013`, `4029`; frame cap 1 MiB → 512 KiB → bound the cost of one abusive client.
- [BREAKING] Collab app imports `TenancyModule` only; consumers and jobs had no host → new `DraftsProjectorModule` (consumers, jobs) deployed by the projector or worker app; `CollabModule` and `DraftsModule` stay the only other exports (X.4, D-8).

## CONTRACT

- [CONTRACT] S05 `ProductCommandService.create/update` inside S06's transaction → they must join the caller's open transaction (ambient) when present → publish needs status, version row, product change and both events to commit together; S06 is in the same domain, so this is not a cross-owner transaction.
- [CONTRACT] S05 validation → `create/update` throw `ProductValidationError { issues: { field, code }[] }` using the S05 limits (title, price 1…10,000,000,000, quantity, text lengths) → S06 must not copy product limits; it maps issues to `422 listing_invalid`.
- [CONTRACT] S05 unchanged update → returns an outcome that says `unchanged` with the current `version` and writes no event (S05 AS-09) → AS-39 needs publishing an identical draft to succeed.
- [CONTRACT] S03 `roleHasPermission(role, permission)` pure export (and the role→permission table behind `GET /shop-roles`) → the 60 s re-check reads `MembershipQueryService.getMembersByShopIds` (one call per shop, not per user) and must decide write vs read without a call per member.
- [CONTRACT] S03 events consumed (`member_removed`, `member_role_changed`, `shop_status_changed`, `shop_offboarding_started`, `shop_deleted`) → the payload of `shop_offboarding_started` carries at least `shopId`; S03 keeps the topic keyed by `shopId` → rooms need only `shopId`/`userId`.
- [CONTRACT] S03 `ShopScoped` gate on every draft route including `products.read` routes (S03 AS-12: suspended shops answer `403 shop_suspended` for any non-`shop.read` permission) → listing drafts of a suspended shop is therefore refused too.
- [CONTRACT] New event `catalog.draft_published` v1 on topic `drafts.events` → emitted for audit and later consumers; nobody consumes it yet and no other capability must change.
- [CONTRACT] Idempotency-Key facility (`libs/infrastructure/idempotency`) and the Redis pub/sub backplane (`libs/infrastructure/redis-pubsub`) have no owning capability in `capabilities.tsv` → assumed S54 (idempotency) and S51 (backplane); S06 requires replay, in-flight 409, reuse 422 and TTL 24 h, and a best-effort publish/subscribe with timeouts.
- [CONTRACT] W04 → the draft editor page is not named in any W spec; it must consume the Provides section (connect, close-code handling, reconnect with backoff, `acknowledgeProductVersion` dialog, version list, publish with an `Idempotency-Key` generated per attempt) and own the one Playwright journey of the test plan.
- [CONTRACT] S50 policies `catalog.draft-connect.user`, `catalog.draft-write.shop`, `catalog.draft-publish.shop`; S49 jobs `drafts.release-stale-publishing`, `drafts.purge-superseded-snapshots` → names are exact so the registries can list them.
- [CONTRACT] Interview-Prep copy of SD-16 → `~/workspace/notes/Interview-Prep/docs/showcase/sections/SD-16-collaborative-listing-editor.md` does not exist; the repo copy `docs/showcase/sections/SD-16-collaborative-listing-editor.md` and `10-System-Design/06-realtime-and-collaboration.md` §16 were used → correct the `capabilities.tsv` source path if needed.

## LOCAL

- [LOCAL] Version restore into the live draft → out of scope; a version is readable only → not in the notes' list; avoids rewriting CRDT history.
- [LOCAL] Archive endpoint added (`ARCHIVED` was in the CHECK but unused) → `DRAFT → ARCHIVED` terminal, rooms close `4005`.
- [LOCAL] 200 open drafts per shop, 200 versions per draft → bounds storage; atomic count.
- [LOCAL] Flush 100 ms, compaction every 200 flushes, idle unload 30 s, ping 30 s, instance heartbeat expiry 15 s, ring refresh 2 s → kept from today's code and the notes.
- [LOCAL] Log entry cap 300 KB (store item limit 400 KB) and large updates split → keep every accepted update storable.
- [LOCAL] Membership re-check every 60 s; backlog cap 8 MiB or 30 s; freeze timeout 3 s; lease 60 s → numbers chosen for the stated recovery bounds.
- [LOCAL] Superseded snapshots kept 10 minutes then deleted by a daily job; orphan version objects older than 1 hour deleted → compaction never deleted old snapshots.
- [LOCAL] Specs rendered as a "Specifications" section of the description (keys sorted) and parsed back → keeps the product model unchanged and avoids duplicate spec lines on re-edit.
- [LOCAL] Draft label (`title`) separate from the document title → list display only.
- [LOCAL] Platform currency implied; only `priceMinor` in the document → one currency in S05.
- [LOCAL] Offboarding freezes drafts; no draft export → published content is in products.
- [LOCAL] Presence timeout 30 s, 8 KiB per presence frame, entries owned per connection → ephemeral data bounded.
- [LOCAL] Event consumers use the framework's inbox for idempotency; purge on `shop_deleted` is bounded (100 drafts per transaction) → IV.5.
- [LOCAL] Storage tables (`DocUpdates`, snapshot prefix) are owned by `catalog` and reached through its own infra; the generic `dynamo` and `storage` libs stay domain-agnostic.
