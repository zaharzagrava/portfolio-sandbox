# Feature Specification: S09 — Offline-First Inventory Sync for Store Devices: Operation Idempotency, Deltas, Per-Field Last-Writer-Wins, Conflicts (domain `catalog-sync`)

**Feature Branch**: `S09-offline-sync` (spec directory `specs/domains/S09-offline-sync`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Offline-first inventory sync for store devices (op idempotency, deltas, per-field LWW, conflicts) (domain `catalog-sync`)". Sources: `docs/showcase/sections/SD-06-offline-inventory-sync.md`, note 10-System-Design/04 §6 (offline-first PWA), note 06-Distributed-Systems/02 §3.3 and §6 (conflict strategies, clocks and ordering). Pattern map rows: **P0612** (bidirectional sync, echo suppression, conflict queue), **P0615** (clocks and ordering, server time authority, HLC), **P0905** (offline-first PWA, backend half).

## Scope

Shop staff at pop-up stores and warehouses count stock, receive deliveries and sell in person with poor connectivity. Their device keeps working offline, queues what staff did as small **operations**, and later **pushes** them; it **pulls** what changed on the server since it last looked. Several devices may touch the same product while offline. This capability makes that safe: nothing is applied twice, nothing is lost, devices converge, and the few cases a machine cannot settle are shown to a person.

In scope (backend half; the device app is phase 2):

- **Push**: a batch of device operations, each identified by a client-generated ID, applied exactly once however often it is sent.
- **Stock as deltas**: "+5 received", "−1 sold" and "I counted 8 where I saw 10" merge without conflicts and in any order; stock never goes below zero.
- **Per-field last-writer-wins** for product title, price and description, ordered by hybrid logical clocks (not device wall clocks).
- **Pull**: "what changed since my cursor" from a per-shop change feed with a gap-free sequence, including changes made by others (online orders, the dashboard, imports, integrations).
- **Conflicts** a machine cannot settle (an oversold last unit, a quantity over the limit): recorded, listed, dismissible by staff with write permission, announced by an event.
- Device-side concerns that the server must support: re-authentication before pushing, server time authority, resync after the feed is rebuilt or compacted.

Out of scope (owners named):

- Writing products and stock: **S05** (`catalog`). This capability never writes the product table (domain map: "it never writes `Product` directly"); it calls S05's exported commands (IX.7 **R1**).
- Bulk file import → **S07**; Shopify/WooCommerce sync → **S08**. They share the domain folder, not these tables or routes.
- The device application itself (installable app, local database, background sync, local schema migrations) → phase 2; the seller dashboard's conflict review screen → **W04**.
- Creating products on a device (new SKUs offline): not supported; a device can only operate on products it has pulled.
- Shop membership, roles, offboarding workflow → **S03**; rate-limit engine → **S50**; outbox, event consumers → **S53**; scheduled jobs → **S49**; error format, metrics, request context → **S54**.
- Cryptographic signing of every operation with a per-device key: not built (see Assumptions); operations are attributed to the authenticated user and the device ID at push time.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Two offline devices change the same product's stock and converge (Priority: P1)

A shop has a warehouse tablet and a pop-up till. Both go offline. The warehouse receives 3 units; the till sells 1. When each reconnects, in either order, the shop's stock is the starting quantity plus 2 and every operation is recorded once, no matter how many times a flaky connection resends it.

**Why this priority**: Stock correctness is the reason the capability exists; double-applied or lost sales are direct money loss.

**Independent Test**: Seed a product with stock 10; push `+3` from one device and `−1` from another in both orders; replay one batch; assert stock 12, one record per operation, and one stock event per applied operation.

**Acceptance Scenarios**:

1. **AS-01** (deltas commute) — **Given** a product of shop `S` with quantity `10`, device `dev-a` holding `stock.adjust +3 reason received` and device `dev-b` holding `stock.adjust −1 reason sold`, **When** `dev-b` pushes first and `dev-a` second (and, in a second run from the same start, `dev-a` first), **Then** in both runs every result is `{status: "applied", replayed: false}` with `quantityAfter` 9 then 12 (or 13 then 12), the final quantity is `12`, each result carries the product's new `productVersion`, two operation records exist, and the catalog emitted exactly one `catalog.product_updated` event per operation with `changedFields: ["quantity"]` and none written by this capability.
2. **AS-02** (replay) — **Given** AS-01's batch of `dev-a` already applied, **When** the identical batch is pushed again (even ten times), **Then** each response returns `{status: "applied", replayed: true}` with the **original** `quantityAfter` and `productVersion`; the quantity stays `12`, no operation record and no event is added.
3. **AS-03** (concurrent replay) — **Given** one new operation, **When** the same batch is pushed twice at the same moment (`Promise.all`), **Then** the stock changed exactly once; both responses report the same outcome; exactly one response has `replayed: false`.
4. **AS-04** (ID reused with different content) — **Given** an applied operation `X` (`+3`), **When** a push carries operation ID `X` with `delta: +30`, **Then** that operation's result is `{status: "rejected", code: "op_id_reused"}`; the stored operation, the quantity and the event count are unchanged.
5. **AS-05** (IDs are scoped to the shop) — **Given** shop `A` applied operation ID `X` and shop `B` (another tenant) pushes an operation with the same ID `X` for its own product, **Then** B's operation is applied normally (`replayed: false`) and A's record is untouched; B's response never reveals that `X` exists elsewhere.
6. **AS-06** (a count becomes a delta) — **Given** quantity `10`, a device that saw `10` and counted `8`, and another device's earlier `−1 sold` already applied (quantity 9), **When** the count (`counted: 8, base: 10`) is pushed, **Then** it is applied as `−2`: the quantity is `7`, the result detail shows `delta: -2`.
7. **AS-07** (count confirms) — **Given** quantity `10`, **When** `stock.count {counted: 10, base: 10}` is pushed, **Then** `{status: "applied", quantityAfter: 10}`, no stock event is emitted and the operation is still recorded (replay returns it).
8. **AS-08** (oversold last unit) — **Given** quantity `1` and two devices each holding `−1 sold`, **When** both push at the same moment, **Then** exactly one result is `applied` and the other `{status: "conflict", conflict: {kind: "oversold", requested: -1, applied: 0, shortfall: 1}}`; the quantity is `0` (never negative); one open conflict exists; one `catalog_sync.offline_conflict_opened` event is in the outbox.
9. **AS-09** (partly oversold) — **Given** quantity `2`, device A sells `1` (applied, quantity 1), **When** device B pushes `−3`, **Then** the result is `conflict` with `requested: -3, applied: -1, shortfall: 2`, the quantity is `0`, and the conflict lists those numbers.
10. **AS-10** (over the quantity limit) — **Given** a product whose quantity plus a pushed `+100000` would exceed the catalog's maximum quantity, **When** pushed, **Then** `{status: "conflict", conflict: {kind: "quantity_limit", requested: 100000, applied: 0}}`, the quantity is unchanged and an open conflict exists.
11. **AS-11** (unknown or foreign product) — **Given** a product ID that does not exist, and another product ID that belongs to shop `B`, **When** shop `A`'s device pushes stock and field operations for each, **Then** every such operation is `{status: "rejected", code: "unknown_product"}` with identical bodies for both cases (no existence leak), and nothing is written in either shop.
12. **AS-12** (archived product) — **Given** an archived product, **When** a stock operation or field edit for it is pushed, **Then** `{status: "rejected", code: "product_unavailable"}` and nothing changes.
13. **AS-13** (crash between applying and recording) — **Given** a fault that makes the store refuse the write of an operation's result once, right after its stock change was applied, **When** the push is made (it fails with `503 sync_unavailable`), the clock moves `61 s` and the same push is repeated, **Then** the repeat returns `{status: "applied", replayed: false}` with the `quantityAfter` that the single stock change produced, the stock changed exactly once in total, and exactly one stock event exists; a further repeat returns `replayed: true`.
14. **AS-14** (in flight, then recovered) — **Given** an operation claimed `45 s` ago by a request that never finished (frozen clock), **When** the same operation is pushed, **Then** its result is `{status: "retry", code: "in_flight"}` and nothing is applied; **Given** the claim is `61 s` old, **Then** the push takes it over and completes it once (no double effect); **And** the scheduled recovery job (run twice and on two instances at once) completes claims older than 5 minutes exactly once each.

---

### User Story 2 — Two devices edit different fields of the same product and both edits survive (Priority: P1)

One device changes a product's title while another changes its price. Both reach the server in any order. Each field keeps the newest edit by logical clock; a late-arriving stale edit loses only its own field and the device is told so.

**Why this priority**: Without per-field resolution one device's whole edit would overwrite the other's, silently.

**Independent Test**: Push title and price edits from two devices in each order and a third, older title edit; assert the final fields, the per-field results and that only winning edits produce a catalog event.

**Acceptance Scenarios**:

1. **AS-15** (both edits survive) — **Given** a product, **When** device A pushes `{title: "Hoodie (black)"}` at clock `T-10 s` and device B pushes `{priceMinor: 4500}` at clock `T-5 s`, in either arrival order, **Then** both results are `applied` with `applied: ["title"]` / `["priceMinor"]`, the product shows the new title and price, and each field has its own stored clock.
2. **AS-16** (stale edit loses its field only) — **Given** AS-15's state, **When** device C pushes `{title: "Old title"}` at `T-20 s`, **Then** `{status: "merged", applied: [], superseded: ["title"]}`; the product is unchanged; no `catalog.product_updated` event is added; the operation is recorded with its outcome; a mixed edit `{title (stale), description (new)}` applies only the description and reports `superseded: ["title"]`.
3. **AS-17** (ties break deterministically) — **Given** two edits of the same field with the same physical time and counter from nodes `dev-a` and `dev-b`, **When** they arrive in either order, **Then** the edit from `dev-b` (greater node ID) wins both times; an edit whose clock equals the stored clock exactly loses (`superseded`).
4. **AS-18** (concurrent edits of one field) — **Given** two pushes at the same moment (`Promise.all`) editing the title of the same product with different clocks, **Then** exactly one title is stored — the one with the greater clock — and the other result is `merged` with `superseded: ["title"]`; this holds for 20 repetitions with random arrival order.
5. **AS-19** (implausible clock on an edit) — **Given** a frozen server time, **When** a `product.update` carries a clock more than `60 s` ahead of it, **Then** `{status: "rejected", code: "clock_implausible"}`, the product and its clocks are unchanged, and the server clock in the response is not moved by that operation; **When** a **stock** operation carries the same skewed clock, **Then** it is applied (stock deltas do not depend on clocks).
6. **AS-20** (invalid clock) — **Given** operations whose clock is malformed, or whose node part differs from the `X-Device-Id` of the request, **Then** `{status: "rejected", code: "invalid_hlc"}` or `"hlc_node_mismatch"` respectively; nothing is applied.
7. **AS-21** (too old) — **Given** an operation whose clock is more than `30 days` behind the server, **Then** `{status: "rejected", code: "op_expired"}` and nothing is applied (devices must sync within that window; see Assumptions).
8. **AS-22** (field values the product refuses) — **Given** edits with an empty title, a title over the catalog's length limit, a negative or fractional `priceMinor`, or an unknown field, **When** pushed in a batch with valid operations, **Then** schema violations are `rejected` with `code: "invalid_op"` and the failing paths in `detail`; values the catalog itself refuses are `rejected` with `code: "invalid_field"` and the field name; no clock is advanced for a rejected operation; the valid operations in the batch are applied normally (see AS-33).
9. **AS-23** (server time authority) — **Given** a push, **Then** the response's `serverHlc` is greater than every clock of the operations accepted in that request and not behind the server's wall time; successive responses from the same server instance never decrease; **And** a device that merges `serverHlc` with the receive rule produces clocks greater than both its own and the server's.

---

### User Story 3 — A device pulls everything that changed since it last looked, including changes it did not make (Priority: P1)

A device asks "what changed since my cursor". It gets product changes in order — including an online order that lowered stock and a dashboard price change — page by page, and never misses or double-applies one. After a feed rebuild or a very long absence it is told to start again from scratch.

**Why this priority**: Without a trustworthy pull, devices drift; offline-first fails on its read side.

**Independent Test**: Change a product through the catalog's own commands and through a push; pull from the start, page by page; assert order, completeness, versions and the empty pull at the end.

**Acceptance Scenarios**:

1. **AS-24** (everything after the cursor, in order) — **Given** a shop whose feed holds the state at `cursor C`, **When** the stock is lowered by an online order, a title is edited from the dashboard and a device pushes `+5`, **Then** `GET …/sync/pull?cursor=C` returns the three changes in increasing `seq` with consecutive `seq` values, each `{seq, entity: "product", id, version, deleted: false, data: {title, description, priceMinor, currency, quantity, status}}`, `hasMore: false`, and a new `cursor`; pulling with that cursor returns no changes and the same cursor.
2. **AS-25** (paging) — **Given** 5 changes and `limit=2`, **When** the device follows the cursors, **Then** pages hold 2, 2 and 1 changes, `hasMore` is `true, true, false`, and the union equals the 5 changes with no gap and no repeat.
3. **AS-26** (no holes under concurrent writers) — **Given** 30 product changes of one shop produced at the same moment (`Promise.all`) while a device pulls repeatedly, **Then** the final `seq` values are exactly `1…30` without gaps, and the union of everything the device was given equals all 30 changes (a change never appears with a `seq` below one the device already received).
4. **AS-27** (duplicate and out-of-order events) — **Given** the catalog's `catalog.product_updated` event for version 7 delivered twice, **Then** the feed holds one entry for it; **Given** the event for version 6 arrives after version 7, **Then** it is ignored and the feed's entry for the product stays at version 7.
5. **AS-28** (invalid event) — **Given** a product event with a missing `shopId`, a missing `productVersion`, a malformed ID or an unknown `type`, **Then** it is rejected or dead-lettered, the feed is unchanged and the consumer keeps processing the next event.
6. **AS-29** (archive, restore, delete) — **Given** a product that is archived, restored and later deleted, **Then** the feed holds entries in that order: `data.status: "ARCHIVED"`, `data.status: "ACTIVE"`, then `{deleted: true, data: null}` (a tombstone), each with the product's version.
7. **AS-30** (own changes come back as no-ops) — **Given** a device pushed `+5` and received `productVersion: 12`, **When** it pulls, **Then** the feed entry for that change has `version: 12` and the quantity the device already holds, so applying it changes nothing (version-based echo suppression); the device can drop any entry whose `version` is not greater than the version it holds for that product.
8. **AS-31** (cursor and limit validation) — **Given** a malformed cursor, a cursor issued for another shop, `limit=0`, `limit=501` or `limit=abc`, **Then** `400` with `code: "invalid_cursor"` or `"validation_failed"`; nothing is returned; no silent fallback to the start.
9. **AS-32** (resync required) — **Given** a cursor from before the feed was rebuilt, a cursor ahead of the feed's head, or a cursor older than the tombstone retention horizon (`30 days`, frozen clock), **Then** `410` with `code: "resync_required"`; **When** the device pulls without a cursor, **Then** it receives the current state of every product of the shop (at least one entry per product, tombstones for deletions within the horizon) and a cursor from which normal pulls continue.

---

### User Story 4 — A bad operation never blocks the device's queue, and requests respect limits (Priority: P1)

A device queue holds 200 operations, one of them malformed. The batch is processed: 199 are applied and the broken one is reported by position, so the device can show it and move on. Oversized, throttled or timed-out requests fail in ways the device can retry safely.

**Why this priority**: A queue that stops on one poison operation strands every later sale on that device.

**Independent Test**: Push a mixed batch, an oversized batch and a throttled burst; assert per-operation results and that a retry after any failure produces no double effect.

**Acceptance Scenarios**:

1. **AS-33** (per-operation outcomes) — **Given** a batch of three operations whose middle one fails the schema, **When** pushed, **Then** `200` with three results in order — `applied`, `{status: "rejected", code: "invalid_op", detail: {issues: [...]}}`, `applied` — each with its `index`; the first and third took effect; the stock of both is changed once.
2. **AS-34** (duplicates inside a batch) — **Given** a batch that contains the same operation twice, **Then** the second result is `replayed: true` with the first one's outcome; **Given** the same ID with different content, **Then** the second is `rejected` `op_id_reused`.
3. **AS-35** (envelope validation) — **Given** a missing or malformed `X-Device-Id` (outside 4–64 characters of letters, digits, `_`, `-`), `ops` missing, not an array, empty, or longer than 500, an unknown top-level field, or a body over `2 MiB`, **Then** `400 validation_failed` (`413 payload_too_large` for the size), nothing is applied.
4. **AS-36** (rate limit) — **Given** a device that exceeds its push budget (fail-closed policy `catalog-sync.sync-push.device`), **Then** `429` with `Retry-After`, none of that request's operations is applied; **When** the same batch is pushed after the window, **Then** it applies once. The same for pull (`catalog-sync.sync-pull.device`).
5. **AS-37** (time budget) — **Given** a batch of 500 operations and a store forced to answer slowly so the request's processing budget (`20 s`) runs out after 120 operations, **Then** `200` with 120 results and the remaining 380 as `{status: "retry", code: "deadline_exceeded"}`; **When** the device resends the whole batch, **Then** the first 120 return `replayed: true`, the rest are applied, and every stock effect happened once.
6. **AS-38** (store failure mid-batch) — **Given** a fault that fails the store on the 3rd operation, **Then** `503` problem `sync_unavailable` (no query text, stack or internal message in `detail`), the first two operations are durable, and the resend returns them `replayed: true` and applies the rest once.

---

### User Story 5 — Staff review the cases a machine cannot settle (Priority: P2)

When two devices sold the last unit, the shop's stock is zero and someone must find out what happened. Staff with write access list open conflicts, see who sold what, and dismiss the ones they dealt with (by recounting or adjusting stock through the normal product screen).

**Why this priority**: Conflicts are rare but expensive; the list is how they stop being silent.

**Independent Test**: Create an oversold conflict, list it, dismiss it, repeat the dismissal, and try it as a viewer and from another shop.

**Acceptance Scenarios**:

1. **AS-39** (list and paging) — **Given** 3 open and 2 dismissed conflicts, **When** `GET /shops/:shopId/sync/conflicts?limit=2` (default status `open`), **Then** `{items, nextCursor}` with the newest first, ties broken by operation ID, each item `{opId, deviceId, productId, kind, requested, applied, shortfall, quantityAfter, status: "open", createdAt}`; the next page completes the 3; `?status=dismissed` returns the other two with `dismissedAt` and `dismissedBy`; an invalid `status` or `limit` is `400 validation_failed`.
2. **AS-40** (dismiss) — **Given** an open conflict, **When** a member with `products.write` calls `POST /shops/:shopId/sync/conflicts/:opId/dismiss`, **Then** `200` with `status: "dismissed"`, `dismissedBy`, `dismissedAt`; a second call is `409 conflict_not_open`; two simultaneous calls give exactly one `200` and one `409`; the stored operation result is unchanged.
3. **AS-41** (conflict access) — **Given** another shop's conflict ID addressed through this shop's path, **Then** `404 not_found`; a `VIEWER` may list but gets `403 permission_denied` on dismiss and nothing changes.

---

### User Story 6 — Only the shop's own staff can sync, and only for their shop (Priority: P1)

A device is signed in as a staff member. Its queued operations are checked against that person's rights at the moment of push — a person removed while offline cannot push — and no device can read or change another shop's data.

**Why this priority**: Tenant isolation and authorization are the security core of any sync endpoint.

**Independent Test**: Call all four routes without credentials, as each role, as a removed member, as a member of another shop, and for a suspended shop.

**Acceptance Scenarios**:

1. **AS-42** (unauthenticated) — **Given** no credentials or an expired access token, **When** any of the four routes is called, **Then** `401` problem; nothing is applied; a device keeps its queue and retries after signing in again.
2. **AS-43** (roles) — **Given** one user per role of the shop, **Then** `OWNER`, `ADMIN` and `STAFF` can push, pull, list and dismiss; `VIEWER` can pull and list but gets `403 permission_denied` on push and dismiss with nothing applied.
3. **AS-44** (cross-tenant, IDOR) — **Given** a member of shop `A`, **When** they call push, pull, list or dismiss under `/shops/B/…` (with B's product IDs, B's cursor or B's conflict IDs), **Then** `404 not_found` every time, with a body identical to that of a shop that does not exist; nothing is applied or revealed; shop A's pull never contains an entry of shop B.
4. **AS-45** (removed while offline) — **Given** a member whose membership was removed after their device queued operations, **When** the device pushes, **Then** the response is the non-member `404` of AS-44 and nothing is applied.
5. **AS-46** (shop status) — **Given** a `SUSPENDED` shop, **When** a device pushes, **Then** `403 shop_suspended`; **Given** an offboarding shop, **Then** `409 shop_offboarding` (the status gate of S03); pull and list follow the gate for `products.read`.
6. **AS-47** (identity from the session only) — **Given** a push whose operations carry a `shopId`, `userId` or `deviceId` field in the body, **Then** it is refused as an unknown field (AS-22/AS-35); the shop comes from the path after the membership check, the user from the session, the device from `X-Device-Id`; each stored operation records all three.

---

### User Story 7 — Operations follow the life of the shop, and operators can see what is happening (Priority: P3)

When a shop is deleted its sync data is purged; deleted products lose their clocks; old operation records and old feed entries are cleaned up; and operators see rates, conflicts, lag and failures without any customer data in the logs.

**Why this priority**: Required for retention, privacy and operations, but off the main path.

**Independent Test**: Deliver the shop-deleted and product-deleted events twice; run the purge jobs; inspect logs and metrics for one push.

**Acceptance Scenarios**:

1. **AS-48** (shop deleted) — **Given** a shop with operations, feed entries, sequence state, clocks and conflicts, **When** `tenancy.shop_deleted` is delivered twice, **Then** all of that shop's rows are removed, once; other shops are untouched; an invalid payload is dead-lettered with no effect.
2. **AS-49** (product deleted) — **Given** a product with field clocks, **When** `catalog.product_deleted` is delivered twice, **Then** its clocks are removed, once; its operations stay for the retention window.
3. **AS-50** (operation retention) — **Given** operation records `95 days`, `85 days` and `10 days` old (frozen clock) and an open conflict whose operation is `120 days` old, **When** the purge job runs (twice, two instances at once), **Then** only the `95 days` record is removed and the open conflict's record stays; dismissed conflicts follow their operation.
4. **AS-51** (observability) — **Given** one push of 3 operations (applied, merged, conflict), **Then** the log lines carry `requestId`, `shopId`, `deviceId` and, per operation, `opId`, `type`, `status`, `code`, duration, and **no** product titles, descriptions or request bodies; the metrics registry shows operation counters by `type` and `status`, a push-duration histogram, the feed-lag gauge (age of the oldest unprocessed product event), the open-conflict gauge and the number of operations in flight.
5. **AS-52** (stock writes go only through the catalog) — **Given** any applied stock operation (including one that was clamped by AS-09), **Then** the product events for it were written by the catalog (never by this capability), each stock change used one catalog command with a deterministic operation ID, and a replay of the operation called the catalog at most with the same ID (no second effect).
6. **AS-53** (boundaries) — **Given** the merged code, **Then** `pnpm --dir packages/backend check:table-ownership --strict` reports no finding in `catalog-sync` for this capability's files, no table of this capability references a catalog table at database level (foreign key, view, trigger or function), and `check:boundaries` has no new finding (static gate, IX.5/X.6).
7. **AS-54** (convergence property) — **Given** random sets of stock and field operations from 2–3 devices (generated), **When** applied in every arrival order and with every operation duplicated, **Then** the final stock and field values are identical (pure merge rules).
8. **AS-55** (feed compaction) — **Given** feed entries older than 30 days of which some are superseded by newer entries for the same product, **When** the compaction job runs (twice, and on two instances at once), **Then** superseded old entries are removed, the newest entry per product is kept, tombstones younger than 30 days are kept, and a pull from a cursor younger than the horizon returns the same final state as before.

### Edge Cases

- A device pulls from cursor 0 on a shop that has 100,000 products: paging only; each page ≤ 500 entries; no request loads the whole feed.
- A device edits a title offline, and meanwhile the seller edits the same title in the dashboard: the dashboard edit has no field clock, so the device's edit is compared only with clocks of other device edits and applies; the seller sees the device's value and may edit again (Assumptions: field clocks decide).
- Stock count with `counted` below zero or `base` above the quantity limit: invalid operation (`invalid_op`).
- A zero `stock.adjust` delta: invalid operation (`invalid_op`).
- A batch with 500 operations on the same product: applied in order, each its own recorded result.
- A product event for a product with no shop (legacy): rejected as invalid payload (AS-28).
- Server restarts between a claim and its completion: AS-14.
- Two server instances: operation IDs, clocks and the feed's sequence are decided in shared storage, never in process memory; the server clock is per instance and monotonic.
- A device whose clock is hours behind but within 30 days: its stock operations apply; its field edits are likely to lose (LWW by clock), and are reported `superseded`.
- A device whose clock is 5 minutes ahead: field edits `clock_implausible` (device must fix its clock or re-stamp using `serverHlc`); stock operations apply.

## Requirements *(mandatory)*

### Functional Requirements

**Push and idempotency**

- **FR-001**: A shop member with `products.write` MUST be able to push a batch of 1–500 operations, processed in the given order, each atomic and independently reported by `index`, with the response `200 {results, serverHlc}` (AS-01, AS-33).
- **FR-002**: Each operation MUST carry a client-generated UUIDv7 `opId`, a `type` (`stock.adjust`, `stock.count`, `product.update`), a clock, the target `productId`, and its payload; unknown fields are refused (AS-22, AS-35, AS-47).
- **FR-003**: An operation MUST take effect at most once per `(shopId, opId)`; replaying it returns the original outcome with `replayed: true` and the original `quantityAfter` / `productVersion`, and changes nothing (AS-02, AS-03, AS-34).
- **FR-004**: The same `opId` with different content MUST be refused with `code: "op_id_reused"`; the same `opId` in different shops MUST be independent and non-observable (AS-04, AS-05).
- **FR-005**: An operation claimed but not finished within `60 s` MUST be reported `retry` / `in_flight` to other requests; after that it MAY be taken over, and a scheduled recovery MUST complete claims older than 5 minutes; completing a half-applied operation MUST NOT repeat its effect (AS-13, AS-14).
- **FR-006**: A result MUST be one of `applied`, `merged`, `conflict`, `rejected`, `retry`, each with a stable `code` where not `applied`; codes: `invalid_op`, `invalid_hlc`, `hlc_node_mismatch`, `clock_implausible`, `op_expired`, `op_id_reused`, `unknown_product`, `product_unavailable`, `invalid_field`, `in_flight`, `contention` (a field edit still racing after 3 attempts), `deadline_exceeded` (AS-04, AS-11, AS-12, AS-19–AS-22, AS-37).
- **FR-007**: A malformed operation MUST be rejected individually without blocking others; only envelope errors fail the request (AS-33, AS-35).
- **FR-008**: A push MUST stop starting new operations after the processing budget and report the rest as `retry` / `deadline_exceeded`; a store failure MUST return `503` with a generic problem, earlier operations staying durable (AS-37, AS-38).
- **FR-009**: Every operation's record MUST keep `shopId`, `deviceId`, the authenticated user, type, clock, content fingerprint, the content needed to complete it, result, detail and timestamps, for 90 days (open conflicts: until dismissed + 90 days) (AS-47, AS-50).
- **FR-010**: Operations whose clock is more than 30 days old MUST be rejected `op_expired` so that a replay can never outlive its record (AS-21).

**Stock deltas**

- **FR-011**: Stock operations MUST be commutative deltas: `stock.adjust` applies `delta` (non-zero integer, |delta| ≤ 100,000, `reason` ∈ received, sold, damaged, returned, other); `stock.count` applies `counted − base` (integers, 0 ≤ counted, base ≤ 1,000,000); a zero delta is not sent to the catalog (AS-01, AS-06, AS-07).
- **FR-012**: Stock MUST change only through the catalog's exported stock command with a deterministic operation ID derived from `(shopId, opId)`, so a repeat can never apply twice; this capability MUST NOT write stock or publish product events itself (AS-52, AS-13).
- **FR-013**: Stock MUST never go below zero: when the full delta cannot be applied, the largest applicable part is applied (down to zero), the rest is recorded as a conflict `oversold` with `requested`, `applied`, `shortfall`; a delta that would exceed the maximum quantity is not applied and recorded as `quantity_limit` (AS-08, AS-09, AS-10).
- **FR-014**: A stock operation on an unknown, foreign or unavailable product MUST be rejected without distinguishing unknown from foreign (AS-11, AS-12).
- **FR-015**: A stock change MUST reach every consumer of the catalog's product events (search, pickup, integrations) as any other stock change, without this capability calling them (AS-01, AS-52).

**Product fields (last-writer-wins per field)**

- **FR-016**: A `product.update` MUST edit only `title`, `description` and `priceMinor` (integer minor units), each optional, at least one present, with the catalog's own limits (AS-15, AS-22).
- **FR-017**: For each field the edit with the greater hybrid logical clock MUST win; a field's stored clock advances only when its edit is applied; ties are broken by the node ID; an exactly equal clock loses (AS-15–AS-18).
- **FR-018**: The decision for one product MUST be serialized: concurrent edits never both see a stale clock (AS-18).
- **FR-019**: The result MUST list `applied` and `superseded` fields; an edit with only superseded fields causes no catalog write and no event; a fully applied or mixed edit makes exactly one catalog update (AS-16).
- **FR-020**: Field edits MUST reach the product only through the catalog's exported update command, retried up to 3 times on a version race, after which the operation is `retry` / `contention`; a value the catalog refuses is `rejected` `invalid_field`, with no clock advanced (AS-22).
- **FR-021**: An operation's clock MUST be a valid hybrid logical clock whose node equals the request's device ID (`invalid_hlc`, `hlc_node_mismatch`); a field edit whose clock is more than `60 s` ahead of the server MUST be rejected `clock_implausible`; stock operations MUST NOT depend on clock plausibility (AS-19, AS-20).
- **FR-022**: Every push response MUST carry a `serverHlc` that is greater than all accepted clocks of that request and never behind server time; server time is the only time authority for plausibility, expiry and retention (AS-23).

**Pull**

- **FR-023**: A member with `products.read` MUST be able to pull `GET /shops/:shopId/sync/pull?cursor&limit` (`limit` 1–500, default 200), receiving product entries in strictly increasing `seq` with `{seq, entity, id, version, deleted, data}`, a `cursor` and `hasMore`; `data` is a copy of the product's `title`, `description`, `priceMinor`, `currency`, `quantity`, `status` (AS-24, AS-25).
- **FR-024**: The feed MUST be built from the catalog's product events (read model, IX.7 R3): one entry per accepted event, `seq` allocated per shop without gaps, an entry visible only when all smaller ones are; duplicate events create no entry, older versions are ignored (AS-26, AS-27).
- **FR-025**: Archive, restore and deletion MUST appear as entries (status change, tombstone) (AS-29).
- **FR-026**: Entries MUST carry the product version, and push results MUST carry the resulting version, so a device recognises its own change in a pull and applies nothing twice (AS-30).
- **FR-027**: The cursor MUST be opaque, bound to the shop and to the feed's generation; malformed or foreign cursors and bad limits are `400`; cursors from an older generation, ahead of the head, or older than the tombstone horizon are `410 resync_required`; a pull without a cursor returns the current state of the shop's products (AS-31, AS-32).
- **FR-028**: Superseded entries older than 30 days MUST be compacted by a single-run job; the newest entry per product and tombstones younger than 30 days stay (AS-55).
- **FR-029**: A committed product change MUST be visible in pull within 5 seconds at p99 under normal load (SC-003); the feed lag is observable (AS-51).

**Conflicts**

- **FR-030**: Each `conflict` result MUST create one open conflict (`opId`, `deviceId`, `productId`, `kind`, `requested`, `applied`, `shortfall`, `quantityAfter`, `createdAt`) and one `catalog_sync.offline_conflict_opened` outbox row in the same transaction as the recorded result (AS-08–AS-10).
- **FR-031**: Members with `products.read` MUST be able to list conflicts with cursor pagination (newest first, ties by operation ID) filtered by `status`; members with `products.write` MUST be able to dismiss an open conflict once (conditional transition; a second attempt is `409 conflict_not_open`) (AS-39–AS-41).

**Access, tenancy, limits**

- **FR-032**: All routes MUST require authentication (`401`), the permission named, and shop membership, answering non-members and other shops' resources with `404`, `403` for a missing permission, and the shop-status gate of S03 for suspended and offboarding shops (AS-42–AS-46).
- **FR-033**: Every lookup of operations, feed entries, clocks and conflicts MUST include the shop in its predicate; the shop, user and device come only from path, session and `X-Device-Id` (AS-44, AS-47).
- **FR-034**: Push and pull MUST be rate limited per device with fail-closed policies, answering `429` with `Retry-After`; body size is capped at 2 MiB (AS-35, AS-36).
- **FR-035**: Errors are RFC 9457 problem+json with the `code`s listed under Provides; no 5xx exposes internals (AS-35, AS-38, AS-43).

**Lifecycle and boundaries**

- **FR-036**: On `tenancy.shop_deleted` all of the shop's sync data MUST be removed idempotently; on `catalog.product_deleted` the product's clocks MUST be removed idempotently (AS-48, AS-49).
- **FR-037**: Operation records MUST be purged after 90 days by a single-run job, except open conflicts (AS-50).
- **FR-038**: This capability MUST read and write only its own tables; products are reached only through the catalog's exported services and events (IX.4, IX.7 R1 and R3), and no table of this capability may reference a catalog table (AS-53).
- **FR-039**: Logs and metrics MUST carry the fields and counters named in the scenario, with no product content or request bodies (AS-51).
- **FR-040**: Operation merge rules (hybrid clocks, delta arithmetic, per-field decision) MUST be pure and deterministic so devices can apply the same rules locally (AS-54).

### Key Entities *(include if feature involves data)*

- **Sync operation**: one device operation, keyed by shop and client ID; type, clock, device, user, content fingerprint, outcome (`pending` while claimed), detail, timestamps.
- **Change feed entry**: one product state per shop sequence number — product ID, version, deleted flag, copied fields; owned by this capability, filled from catalog events.
- **Feed state**: per shop, the last sequence number, the feed's generation and the compaction horizon.
- **Field clock**: per product and field, the clock of the winning edit (and the shop).
- **Conflict**: an operation outcome a person should look at (`oversold`, `quantity_limit`) with the numbers and its status (`open`, `dismissed`).
- **Device**: identified only by the `X-Device-Id` value recorded on operations; no registry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Replaying any batch any number of times changes stock by the same amount as sending it once (100% of replayed operations return `replayed: true`; 0 double effects in the replay and concurrency tests).
- **SC-002**: Two to three devices applying the same operations in any order, with duplicates, end with identical stock and product fields (property test: 0 divergences over 1,000 generated runs).
- **SC-003**: At 99th percentile, a push of up to 50 operations answers within 1 second and a pull page within 200 ms during a store-opening burst of 10,000 requests per second; a committed product change is visible to pull within 5 seconds (load test outside the e2e suite).
- **SC-004**: Stock is never negative after any pushed sequence; every shortfall is visible as an open conflict within one push response and one list call.
- **SC-005**: A malformed operation never prevents the other operations of its batch from being applied (100% in the mixed-batch test).
- **SC-006**: A device with a valid cursor never misses a product change and never receives one twice with a lower version (0 gaps and 0 regressions in the concurrent-writer test).
- **SC-007**: 0 requests across shops return or modify another shop's data (cross-tenant tests: 100% `404`).
- **SC-008**: A device offline for up to 30 days can resynchronise; beyond the horizon it is told explicitly to start over (100% of stale cursors get `410 resync_required`, 0 silent partial syncs).

## Assumptions

- **Catalog contract**: S05's `ProductStockService.applyStockDelta` (all-or-nothing, never below zero, idempotent per operation ID for 30 days, codes `insufficient_stock`, `unavailable`, `not_found`, `quantity_limit`), `ProductQueryService.getProductsByIds`, `ProductCommandService.update` (optimistic version) and `listByShop`, and the events `catalog.product_created|updated|archived|restored|deleted` with `productVersion` exist as S05 specifies. Today none exists; the trigger-fed feed and raw writes are replaced (see `gaps.md`).
- **Max age 30 days, record retention 90 days**: the catalog remembers stock operation IDs for 30 days, this capability remembers operations for 90, and refuses anything older than 30 days by clock; a replay therefore always meets a record. A device offline longer sees its old operations `rejected` / `op_expired` and shows them to the user; that is deliberately preferred to a silent double apply.
- **Clamping**: because stock can never be negative (S05), an oversold sale is applied up to the available quantity and the shortfall is a conflict; the physical world already happened, so staff reconcile by recount, then dismiss.
- **Field clocks decide**: the dashboard and the API edit through the catalog without a field clock; a device edit is compared only with clocks of other device edits. The device sees the server's newer value in its next pull. A finer "edited elsewhere since" check was judged not worth its complexity; this matches note 10/04 §6 ("LWW per field with server versions").
- **Superseded edits are not conflicts**: last-writer-wins is the stated policy for title, description and price; the losing edit is reported in the result and kept in the operation record, not queued for review.
- **No offline product creation, no per-device keys**: devices operate on products they pulled; authenticity comes from re-authentication before push and the permission check at push time; the device ID is an attribution label, not a credential.
- **Server clock** is per instance (node `server-<instance>`), monotonic; plausibility, expiry and retention use server time only.
- **No `Idempotency-Key` header**: V.6 lists order, payment, booking, bid and ledger creations; per-operation IDs give the same guarantee at finer grain and a batch is not itself replay-stored.
- **Freshness**: the feed lags catalog commits by seconds (read model, IX.7 R3); the maximum accepted staleness is 5 s at p99; a device's own change is known immediately from the push result.
- **Numbers are configuration, not contract**: 500 operations per batch, 2 MiB body, 20 s budget, 60 s claim lease, 5 min recovery, 60 s clock drift, 30 d max age and tombstone horizon, 90 d retention, pull limit 1–500 default 200, rate budgets per device (push 30/min, pull 120/min).
- Defaults are listed with reasons in `questions.md`; those that change behaviour that exists today are tagged `[BREAKING]` there.
- **Tests** replace only system edges (identity token verification, clock); the catalog, tenancy, outbox and the rate limiter are real; faults use real mechanisms (a store rule that refuses a write, a slow store).

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web`, `specs/journeys` for `S09` and `catalog-sync`; `specs/web` and `specs/journeys` do not exist yet). **S05** (spec, questions, gaps) requires from this capability that it writes stock only through `ProductStockService.applyStockDelta` with an operation ID, writes products only through S05's commands, stops publishing `products.events` itself and keeps field clocks to itself (honoured: FR-012, FR-020, FR-038, AS-52). S05 lists `ProductImportService.upsertFromExternal` (source `'offline'`) as a consumer contract for S09; **this spec does not use it** (it needs an external SKU and a full item, while a device edits single fields of a known product): `[CONTRACT]` question. **S08** requires that every stock writer goes through `applyStockDelta` so offline sales are pushed to the provider (honoured: FR-012, FR-015, AS-52; proof J04, S08 AS-36). **S07** requires that `catalog-sync.events` is shared and unchanged (honoured: one event type added). **S06** names none. **S03** requires export on `tenancy.shop_offboarding_started` and purge on `tenancy.shop_deleted` (purge honoured: FR-036; export declined: derived operational data, `[CONTRACT]` question). Pattern map: P0612, P0615, P0905. Journey **J04** step "an offline store device sells stock" is AS-01 plus AS-52.

**Provides** (exact names; exported from `@app/domains/catalog-sync` unless it is an HTTP endpoint or event):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts` (`syncPushRequestSchema`, `syncPushResponseSchema` containing `syncOpResultSchema`, `syncPullResponseSchema`, `syncConflictSchema`, `syncConflictPageSchema` = `{items, nextCursor}`, `syncEventSchemas`):
  - `POST /shops/:shopId/sync/push` (permission `products.write`; header `X-Device-Id`) body `{ops: SyncOp[1..500]}` → `200 {results: SyncOpResult[], serverHlc}`; `SyncOp` is `{type: 'stock.adjust', opId, hlc, productId, delta, reason}` | `{type: 'stock.count', opId, hlc, productId, counted, base}` | `{type: 'product.update', opId, hlc, productId, fields: {title?, description?, priceMinor?}}`; `SyncOpResult` is `{index, opId, status: 'applied' | 'merged' | 'conflict' | 'rejected' | 'retry', replayed: boolean, code?, detail?, quantityAfter?, productVersion?, applied?: string[], superseded?: string[], conflict?: {kind, requested, applied, shortfall}}`. Guarantees: exactly-once effect per `(shopId, opId)`, per-operation outcomes, stock never below zero.
  - `GET /shops/:shopId/sync/pull?cursor&limit` (`products.read`; header `X-Device-Id`) → `200 {changes: {seq, entity: 'product', id, version, deleted, data}[], cursor, hasMore, serverHlc}`, `410 resync_required`, `400 invalid_cursor`. Guarantees: increasing, gap-free `seq`; `Cache-Control: no-store`.
  - `GET /shops/:shopId/sync/conflicts?status&limit&cursor` (`products.read`) → `syncConflictPageSchema`; `POST /shops/:shopId/sync/conflicts/:opId/dismiss` (`products.write`) → `200 syncConflictSchema` | `409 conflict_not_open`.
  - Problem `code`s: `validation_failed`, `invalid_cursor`, `payload_too_large`, `resync_required`, `conflict_not_open`, `sync_unavailable`, plus S03's `permission_denied`, `shop_suspended`, `shop_offboarding`, `not_found`, and the platform's `unauthenticated`, `rate_limited`.
  - Removed: the unvalidated numeric cursor, the free-form `price` field (now `priceMinor`), the `duplicate` result, the bare list from `GET …/sync/conflicts`.
- Event (outbox → topic `catalog-sync.events`, key = `opId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`), written once in the transaction that records the conflicting result: `catalog_sync.offline_conflict_opened` v1 `{opId, shopId, deviceId, productId, kind: 'oversold' | 'quantity_limit', requested, applied, shortfall, quantityAfter}`. **Consumers (optional, none required): S28 (tell the shop's admins), S43 (webhook to the shop), S40 (seller activity), W04 (badge, through the HTTP routes).**
- **Behavioural guarantee**: every stock change made by a device reaches the catalog as one `applyStockDelta` call per operation (deterministic operation ID), so search, pickup availability and integrations see it as any other stock change; nobody imports anything from `catalog-sync` for it.
- Modules for the apps: `OfflineSyncModule` (core: HTTP routes), `OfflineSyncWorkerModule` (worker: recovery, compaction and purge jobs), `OfflineSyncProjectorModule` (projector: consumers of `products.events` and of the tenancy shop events). Nothing else is exported (no model, repository, `SyncService`).
- Rate-limit policies (declared in S50's registry): `catalog-sync.sync-push.device` 30/minute per device and shop (fail closed); `catalog-sync.sync-pull.device` 120/minute per device and shop (fail closed); `catalog-sync.conflict-write.shop` 60/minute per shop (fail closed).
- Scheduled jobs (registered with S49, single-run, idempotent): `catalog-sync.redrive-stale-ops` (every minute), `catalog-sync.compact-change-log` (daily), `catalog-sync.purge-sync-operations` (daily).

**Requires** (owner and assumed shape):

- **S05** (`catalog`, R1 from `@app/domains/catalog`): `ProductStockService.applyStockDelta(ops: {operationId, productId, shopId, delta, reason}[]): {outcome: 'applied', results: {operationId, productId, quantityAfter, productVersion, replayed}[]} | {outcome: 'rejected', failures: {operationId, productId, code: 'insufficient_stock' | 'unavailable' | 'not_found' | 'quantity_limit'}[]}` (operation ID `sync:<shopId>:<opId>`, clamp retry `sync:<shopId>:<opId>:clamp`, reason `sync.received|sold|damaged|returned|other`); `ProductQueryService.getProductsByIds(ids, {shopId}): Map<ProductId, ProductDto>` with `quantity`, `version`, `status`, `title`, `description`, `priceMinor`; `ProductCommandService.update(shopId, productId, {expectedVersion, title?, description?, priceMinor?})` throwing `ProductNotFoundError`, `VersionConflictError`, `ProductArchivedError`, `ShopNotActiveError` and — **asked for** — a typed `ProductValidationError {errors: {field, code}[]}`; `ProductCommandService.listByShop(shopId, {limit, cursor})` for rebuilding a shop's feed. **Asked for**: S05 lists S09 as a consumer of `update` and `listByShop`.
- **S05 events** (R3): topic `products.events`, key `productId`, `catalog.product_created|updated|archived|restored` payload `{productId, shopId, title, description, priceMinor, currency, quantity, status, productVersion, changedFields}` and `catalog.product_deleted {productId, shopId, productVersion}`, envelope `{eventId, type, version: 1, occurredAt, aggregateId}`.
- **S03** (`tenancy`): `ShopScoped('products.read' | 'products.write')` with the status gate (`403 shop_suspended`, `409 shop_offboarding`, non-member `404`); event `tenancy.shop_deleted` v1 `{shopId}`.
- **S53**: `outbox.append(event)` inside this domain's transaction (IX.6); the consumer framework (envelope check, payload schema validation, version guard or inbox, DLQ).
- **S49**: single-run scheduled jobs with leases. **S50**: the three policies above, `429` with `Retry-After`. **S54**: problem+json filter with `code` and `requestId`, request context, injectable clock, metrics registry, graceful shutdown, config validation of the numbers above. **S01**: authenticated principal and access-token expiry as `401`.
