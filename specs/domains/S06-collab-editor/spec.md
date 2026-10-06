# Feature Specification: S06 — Collaborative listing drafts (domain `catalog`)

**Feature Directory**: `specs/domains/S06-collab-editor`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S06 — a shop's team co-edits a product listing draft in real time (conflict-free merged editing in rooms), with permissions checked on join and on every update, named version history, and a publish step that turns the draft into a product revision.

Sources read: `docs/showcase/sections/SD-16-collaborative-listing-editor.md` (repo copy; the same path under `~/workspace/notes/Interview-Prep/` does not exist), `10-System-Design/06-realtime-and-collaboration.md` §16 (which wins over the code wherever they differ), constitution v3.1.0, `domain-map.md` (catalog), `pattern-map.md` (the only S06 row is **P1105**), the earlier specs S03 and S05, and the current code of `libs/domains/catalog` (`drafts.*`, `collab.*`, `room*`, `hash-ring`, `draft-store`, `collab-ticket`, `instance-registry`, `listing-doc`, `collab.e2e-spec.ts`).

## Scope

In scope: listing drafts (create, list, archive), editor access (tickets, rooms, routing across editing instances), real-time co-editing and presence, permission checks on join and per update, revocation, named versions, publish to a product, durability (update log, snapshots, compaction), cleanup, and operability.

Out of scope (owned elsewhere):

- Product create, update, archive, stock, cache and events → **S05** (publish only calls its update path).
- Membership, roles, permissions, shop status → **S03**.
- The editor screen (rich-text widget, cursors) → **W04** (this spec fixes the wire contract it needs).
- Restoring an old version into the live draft, comments, rich-text formatting beyond plain text, images in a draft, and offline-first editing of a *closed* browser (reconnect after a network drop is in scope).

Cross-domain data appears only through these mechanisms: **R1** for product content and membership (S05, S03), **R3-style event reactions** for membership and shop status changes (Kafka subscriptions, IV.4–IV.5), and the **IX.6 technical-table exception** for the outbox. No other domain's table is read or written.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Create a draft and get into the editor (Priority: P1)

A seller with write access starts a blank draft, or starts one pre-filled from an existing product, and receives a short-lived way into the editing room. A teammate with read-only access can open the same draft but not change it.

**Why this priority**: nothing else works without a draft and a way into its room.

**Independent Test**: create a draft over HTTP, call connect, and check the returned address, permission level and expiry; repeat as a read-only member and as a member of another shop.

**Acceptance Scenarios**

1. **AS-01** (create blank) — **Given** user `U` is a member of shop `S` with `products.write` and `S` is active, **When** `U` posts `{title: "iPhone 17 listing"}` to `/api/shops/S/drafts`, **Then** `201` with a draft view `{id, shopId: S, productId: null, title, status: "DRAFT", baseProductVersion: null, createdBy: U, createdAt, updatedAt, publishedAt: null}`; exactly one draft row exists with `shopId = S` and `createdBy = U` (both taken from the request context, never from the body); no snapshot or log entry exists yet, and opening the room yields an empty document.
2. **AS-02** (create from a product) — **Given** product `P` of shop `S` at version 7 with title, description, brand, category, price in minor units, quantity, and a description ending in a "Specifications" section, **When** `U` posts `{title, productId: P}`, **Then** `201` with `productId: P` and `baseProductVersion: 7`; the first editor to join receives a document containing those values, with the specification lines parsed back into the spec table (AS-39); the product data was obtained through the exported product command service (R1), and no query touched the product table.
3. **AS-03** (create validation) — **Given** `U` as in AS-01, **When** the body has a missing, empty, whitespace-only, non-string or 121-character `title`, a non-UUID `productId`, or any unknown field (e.g. `status`, `shopId`, `createdBy`), **Then** `400 validation_failed` (problem+json with the failing field names) for each class, and no draft row is created.
4. **AS-04** (create from a missing product) — **Given** a `productId` that does not exist, belongs to another shop, or is `ARCHIVED`, **When** `U` posts it, **Then** the first two answer an identical `404 product_not_found` (the other shop's product is indistinguishable from an unknown one) and the archived one answers `409 product_archived`; no draft row is created.
5. **AS-05** (open-draft limit) — **Given** shop `S` has 199 drafts in `DRAFT` or `PUBLISHING`, **When** two creates arrive at the same time, **Then** exactly one answers `201` and the other `409 draft_limit_reached`, and `S` has exactly 200 open drafts; a shop with 200 open drafts answers every further create `409 draft_limit_reached`; archived and published drafts do not count.
6. **AS-06** (access gates, every route) — **Given** the eight routes of this capability (create, list, connect, archive, versions list, version read, version create, publish), **When** called **Then**: no credentials → `401`; a signed-in user who is not a member of the shop → `404 shop_not_found`; a member without the route's permission (`products.read` for list, connect, versions list, version read; `products.write` for create, archive, version create, publish) → `403 permission_denied`; a `SUSPENDED` shop → `403 shop_suspended`; a `DELETING` shop → `409 shop_offboarding`; in this order, and no state changes in any case.
7. **AS-07** (list) — **Given** 45 drafts in `S` and 5 in another shop `S2`, **When** a member of `S` reads the list with `limit=20`, **Then** `200` with 20 drafts of `S` only, newest `updatedAt` first with the draft id as tie-breaker, and an opaque `nextCursor`; following the cursor yields the next 20 and the final 5 with `nextCursor: null`, with no duplicate and no gap even if drafts are created between page requests; an optional `status` filter returns only drafts in that status; `limit` of `0`, `101` or a non-number, a cursor that is not ours, or a cursor from another shop → `400 invalid_cursor` or `400 validation_failed`.
8. **AS-08** (cross-tenant access) — **Given** `U` is a member of shops `A` and `B` and draft `D` belongs to `A`, **When** `U` calls connect, archive, versions list, version read, version create or publish through `/api/shops/B/drafts/D`, **Then** each answers `404 draft_not_found` with a body identical to the one for a random unknown draft id; nothing changes (no ticket minted, no status change, no version, no product).
9. **AS-09** (connect) — **Given** a draft in `DRAFT` and a member with `products.write`, **When** the member posts to the connect route, **Then** `200 {url, ticket, canWrite: true, expiresAt}` where `url` is the editing address of the instance that currently owns the draft (AS-45) ending in `/collab/<draftId>`, and `expiresAt` is exactly 60 seconds after the (frozen) clock; a member with only `products.read` receives `canWrite: false`; any member connecting to a draft in `PUBLISHING`, `PUBLISHED` or `ARCHIVED` receives `canWrite: false`; the ticket is bound to this draft, shop, user and permission level (AS-13).
10. **AS-10** (connect limits) — **Given** the connect rate limit of 30 per minute per user, **When** a user makes a 31st call within the minute, **Then** `429` with `Retry-After`; **Given** the limiter's store is down, **Then** the call is refused `503` (fail closed); **Given** no editing instance is registered, **Then** `503 collab_unavailable` with `Retry-After: 5` and no ticket is minted.
11. **AS-11** (archive and illegal transitions) — **Given** a draft in `DRAFT`, **When** a member with `products.write` posts archive, **Then** `200` with `status: "ARCHIVED"`, any open room of the draft closes with code `4005 draft_closed` within 5 seconds, and later connects are read-only; **Given** the draft is `PUBLISHED` or already `ARCHIVED`, **Then** `409 invalid_transition` with `currentStatus`; **Given** it is `PUBLISHING`, **Then** `409 publish_in_progress`. The status change is a conditional update that asserts one affected row.

---

### User Story 2 — Edit together in real time (Priority: P1)

Several teammates type in the same listing at once. Everyone sees everyone's changes within a fraction of a second, concurrent edits never lose text, and a teammate whose network dropped catches up when they reconnect.

**Why this priority**: it is the point of the capability.

**Independent Test**: connect two editors to one draft, make concurrent edits, and compare both documents and the persisted state.

**Acceptance Scenarios**

1. **AS-12** (handshake accepted) — **Given** a valid ticket for draft `D`, **When** the client opens the editing connection and sends its first sync message *immediately*, before the server has loaded the room, **Then** the connection is accepted, the early message is not lost, the client receives the room's full state and completes its sync (no hang), and the server starts the exchange itself.
2. **AS-13** (handshake refused) — **Given** the connection address for `D`, **When** the ticket is missing, malformed, expired (61 seconds old), signed with another key, signed with the wrong issuer or audience, an unsigned (`alg: none`) token, issued for another draft, or already used once, **Then** the upgrade is answered `401` and no room is loaded or touched; **When** the request carries an `Origin` that is not on the allowed list, **Then** `403`; **When** the ticket is valid but the draft no longer exists, **Then** the connection closes with `4004 draft_not_found`; the ticket value never appears in any log line.
3. **AS-14** (concurrent edits converge) — **Given** two editors synced to `D`, **When** both insert text at position 0 of the title, and one sets the price while the other sets a spec row at the same time, **Then** both documents become identical (every inserted character present exactly once, both fields set), and the state rebuilt from storage equals the live state.
4. **AS-15** (duplicate update) — **Given** an editor sent update `u` and it was applied, **When** the same bytes `u` are delivered to the room again (network retry), **Then** the document is unchanged (no duplicated text), every connected client still equals the room, and the persisted state equals the live state.
5. **AS-16** (out-of-order updates) — **Given** update `b` depends on update `a`, **When** `b` reaches the room before `a`, **Then** `b` is held without error and without changing the visible document, and once `a` arrives both are applied; the final document equals the one produced by in-order delivery.
6. **AS-17** (offline resume) — **Given** editor `X` loses its connection, makes 3 local edits, and editor `Y` makes other edits meanwhile, **When** `X` reconnects with a fresh ticket and exchanges state markers, **Then** the server sends only the updates `X` is missing (the bytes sent are smaller than the full state), `X`'s 3 edits are merged into the room, and `X`, `Y` and the persisted state are identical.
7. **AS-18** (presence) — **Given** editors with cursors and names, **When** they move, **Then** others receive the cursor updates; a late joiner receives the current cursors; when a socket closes its cursor is removed for everyone within 1 second; a cursor from a client that stopped sending is removed after 30 seconds; presence data is never written to the update log, a snapshot, or a version (the log is unchanged after presence-only traffic); a member cannot overwrite a presence entry announced by another member (the frame is ignored); a presence frame larger than 8 KiB closes the connection with `1009`.
8. **AS-19** (connection and message limits) — **Then**, each outcome exact: a frame over 512 KiB → close `1009`, nothing applied; a frame that cannot be decoded → close `4000 protocol_error`, nothing applied and the room is unchanged; an update that would make the document's encoded state exceed 2 MiB → not applied, not persisted, close `4009 document_too_large`; more than 200 frames per second sustained on one connection → close `4029 rate_limited`; the 51st connection to a room → close `4008 room_full` while the first 50 are unaffected; a user's 6th connection to the same draft → close `4008 too_many_connections`.
9. **AS-20** (dead peer) — **Given** a client that stops answering liveness pings (a sleeping laptop), **When** two ping periods (60 seconds) pass without an answer, **Then** the server terminates the connection, removes the member and its cursor, and the room keeps working for the others.
10. **AS-21** (room load and unload) — **Given** `D` is not loaded, **When** 50 editors open it at the same moment, **Then** the draft's state is loaded exactly once (one read of snapshot and log) and all 50 join; **When** the last editor leaves, **Then** 30 seconds later the room flushes pending updates, compacts, and unloads; **When** someone joins while that unload is in progress, **Then** they wait for it to finish and then load a room that contains every earlier edit, and no second room for `D` ever writes to the log at the same time (no sequence conflict).

---

### User Story 3 — Only the right people can change the draft, and access can be taken away (Priority: P1)

A read-only teammate can watch but not alter. Write permission is checked on join **and** on every update. When someone is removed from the shop or loses write access, the room reacts within seconds, wherever it runs.

**Why this priority**: it is a security boundary of the capability (notes: "check on room join and on each operation; revoke = kick").

**Independent Test**: connect a read-only member and a writer, send a write from the read-only one, then remove a member and watch the sockets.

**Acceptance Scenarios**

1. **AS-22** (read-only member cannot write) — **Given** a member joined with `canWrite: false` and an editor joined with write, **When** the read-only member sends an update or a second-step sync message, **Then** it is not applied, not broadcast to others, not persisted; the sender receives a *permission denied* message with reason `read_only`; the connection stays open and still receives everyone's edits and can send presence; the denied-write counter (`reason=read_only`) increases by 1; one structured log line records draft, shop and user ids and no document content.
2. **AS-23** (write lost mid-session) — **Given** an editor with write, **When** their role changes to one without `products.write` (`tenancy.member_role_changed`), **Then** within 5 seconds their further updates are denied exactly as in AS-22 (connection stays open), their earlier updates stay in the document, and a role change that only *adds* write takes effect on the next connect (a new ticket).
3. **AS-24** (member removed) — **Given** user `U` has sockets in rooms of two drafts of shop `S`, the rooms live on two different instances, **When** `tenancy.member_removed` for `(S, U)` is processed, **Then** every socket of `U` in rooms of `S` closes with `4003 access_revoked` within 5 seconds, other members are unaffected, `U`'s earlier edits remain, and `U`'s next connect answers `404 shop_not_found`. **Given** the instant notification between processes is lost, **Then** the room's periodic membership re-check (every 60 seconds, one batched read per shop) closes the socket within 65 seconds of the removal.
4. **AS-25** (shop no longer active) — **Given** open rooms of shop `S`, **When** `S` becomes `SUSPENDED` (`tenancy.shop_status_changed`) or enters offboarding (`tenancy.shop_offboarding_started`), **Then** its rooms flush and close with `4003 shop_inactive` within 5 seconds and connects answer `403 shop_suspended` / `409 shop_offboarding`; when `S` is `ACTIVE` again, connects work.
5. **AS-26** (event consumers) — **Given** each consumer (member removed, role changed, shop status changed, offboarding started, shop deleted), **When** the same envelope is delivered twice, **Then** the effect happens once (one backplane notification, one purge pass) and the second delivery is acknowledged; **When** the payload is invalid (missing or non-UUID `shopId` or `userId`, unknown role, non-integer version) **Then** it is dead-lettered with no side effect and the next valid event is processed; **When** a stale event arrives after a newer one (a late `member_role_changed` after `member_removed`), **Then** nobody gains access, because every grant is decided by a fresh read from the membership service on connect and on the periodic re-check; events only trigger the re-check sooner.
6. **AS-27** (shop deleted) — **Given** shop `S` with 250 drafts (rooms open, versions, snapshots and log entries stored) and shop `S2` with drafts, **When** `tenancy.shop_deleted` for `S` is processed, **Then** all drafts, versions, snapshots and log entries of `S` are removed in batches of at most 100 drafts per transaction, rooms close with `4003 shop_inactive`, `S2` is untouched; **When** the consumer crashes after the first batch and the event is redelivered, **Then** the purge resumes and finishes, and a second full delivery changes nothing.

---

### User Story 4 — Publish the draft as a product revision (Priority: P1)

When the team agrees, one member publishes. The draft becomes a new product or a new revision of the existing one, exactly once, and the draft is frozen with a "Published" version.

**Why this priority**: it is how drafts create business value.

**Independent Test**: edit a draft, publish it with an idempotency key, and check the product, the version and the events; replay the request.

**Acceptance Scenarios**

1. **AS-28** (publish a new product) — **Given** a draft without a product whose content has a title and a valid price, with edits that the room received just before the request, **When** a member with `products.write` posts publish with `Idempotency-Key: K`, **Then** `200 {productId, productVersion: 1, versionId}`; the product exists in the draft's shop, created by the caller; it contains every edit the room received before the request; the draft is `PUBLISHED` with `productId` and `publishedAt` set; a version of kind `published` named `Published <UTC date and minute from the clock>` holds the frozen state; the product-created event and a `catalog.draft_published` event were written in the same transaction as the status change; open rooms close with `4005 draft_closed`; the draft's `shopId` and the caller come from the request context.
2. **AS-29** (publish a revision) — **Given** a draft created from product `P` at version 7 and `P` is still at version 7, **When** published, **Then** `P` is updated through the product update path with `expectedVersion: 7`, only fields that differ from `P` are sent, `P` is at version 8, the product-updated event lists exactly the changed fields, and the draft is `PUBLISHED`.
3. **AS-30** (product changed since the draft started) — **Given** `P` is now at version 9 and the draft's base is 7, **When** published, **Then** `409 product_version_conflict` with `currentVersion: 9`, the draft returns to `DRAFT` and stays editable, `P` is unchanged, no version or event is written; **When** the publisher repeats the request with `acknowledgeProductVersion: 9` (the version they looked at), **Then** it succeeds and `P` is at version 10; an acknowledged version that is itself stale (`P` meanwhile at 10) → `409 product_version_conflict` again.
4. **AS-31** (invalid listing) — **Given** content with an empty or whitespace-only title, or a missing, zero, negative, non-integer or over-limit price, or a quantity or text over the product limits, **When** published, **Then** `422 listing_invalid` with `errors: [{field, code}]` for each problem (limits are those of S05), the draft returns to `DRAFT`, and no product, version or event is created. Table-driven per field.
5. **AS-32** (product gone) — **Given** the draft's product was archived, or deleted, after the draft started, **When** published, **Then** `409 product_archived` or `409 product_not_found`, and the draft stays `DRAFT` with nothing written.
6. **AS-33** (idempotency) — **Given** a completed publish with key `K`, **When** the identical request is replayed, **Then** the same status and body come back, with no second product, version or event; **When** a request with `K` arrives while the first is still running, **Then** `409 request_in_flight`; **When** `K` is reused with a different body, **Then** `422 idempotency_key_reuse`; **When** the header is missing or longer than 128 characters, **Then** `422 idempotency_key_required` or `422 idempotency_key_invalid`; **When** 24 hours have passed (frozen clock) and `K` is sent again, **Then** it is treated as a new request (and answers `409 invalid_transition` because the draft is already published).
7. **AS-34** (illegal transitions) — **Given** a draft in `PUBLISHED` or `ARCHIVED`, **When** published with a new key, **Then** `409 invalid_transition` with `currentStatus`, nothing changes; **Given** `PUBLISHING` with an unexpired lease, **Then** `409 publish_in_progress`.
8. **AS-35** (concurrent publish) — **Given** one draft, **When** two publishes with different keys run at the same time (`Promise.all`), **Then** exactly one `200` and the other `409 publish_in_progress` or `409 invalid_transition`; exactly one product, one version of kind `published`, one `catalog.draft_published` and one product event exist; **Given** two drafts of the same product published at the same time, **Then** exactly one succeeds and the other answers `409 product_version_conflict`; **Given** publish and archive of the same draft at the same time, **Then** exactly one wins and the other answers `409`.
9. **AS-36** (failure leaves the draft editable) — **Given** the product write or the transaction fails (e.g. a database error), **When** publish runs, **Then** `500` problem+json with a generic detail, the draft is `DRAFT` again before the response is sent, rooms accept writes again, no product, version row, status change or event exists, and a retry with the same key runs the publish afresh and succeeds.
10. **AS-37** (publisher crash) — **Given** a draft in `PUBLISHING` whose lease (60 seconds) has expired because the publisher died, **When** the cleanup job runs, **Then** it returns the draft to `DRAFT` within 2 minutes; before expiry publish answers `409 publish_in_progress`; **Given** the old publisher resumes late and tries to finish, **Then** its completion changes nothing (it no longer holds the lease) and no product change is applied twice.
11. **AS-38** (freeze point) — **Given** an editor typing while a publish starts, **Then** every update the room received before the freeze is in the product, every later update is refused (the sender is closed with `4005 draft_closed`) and not in the product; **Given** no room for the draft is loaded, **Then** publish uses the stored state; **Given** the owning instance is registered but does not confirm the freeze within 3 seconds, **Then** `503 collab_unavailable`, the draft returns to `DRAFT`, and nothing is written.
12. **AS-39** (spec table round trip) — **Given** content with specs `{Storage: "256 GB", Color: "Black"}` and description `Adaptive audio.`, **When** published, **Then** the product description is `Adaptive audio.` + blank line + `Specifications` + lines `- Color: Black` and `- Storage: 256 GB` (keys sorted); **When** a new draft is created from that product, **Then** its description is `Adaptive audio.` and its spec table equals the original; publishing that draft unchanged changes no product field (the product answers the unchanged outcome of S05) and the draft still becomes `PUBLISHED`. This render/parse pair is pure and holds for any description and any spec table without the reserved heading.

---

### User Story 5 — Version history (Priority: P2)

A member saves a named checkpoint ("Before price change"), later lists the checkpoints and views what the listing looked like.

**Why this priority**: safety net for collaborative editing; the notes define version history as named snapshots.

**Independent Test**: edit, create a named version, edit more, and read the version back.

**Acceptance Scenarios**

1. **AS-40** (create a named version) — **Given** a draft in `DRAFT` with edits the room received just before the call, **When** a member with `products.write` posts `{name: "Before price change"}`, **Then** `201 {id, name, kind: "named", createdBy, createdAt}`; reading that version returns the content including every edit the room received before the call (the room is flushed first); edits made later never change it.
2. **AS-41** (version rules) — **When** the name is empty, blank, 81 characters, contains control characters or is not a string, **Then** `400 validation_failed`; **Given** the draft has 200 versions, **Then** `409 version_limit_reached`; **Given** the draft is not in `DRAFT`, **Then** `409 invalid_transition`; **Given** a read-only member, **Then** `403 permission_denied`; no row is written in any of these cases.
3. **AS-42** (list versions) — **Given** a draft with 45 versions (named and published), **When** a member with `products.read` lists with `limit=20`, **Then** the newest 20 first (creation time, then id), each with `kind`, an opaque cursor for the rest, no duplicate across pages; a cursor of another draft or a bad `limit` → `400`.
4. **AS-43** (read a version) — **When** a member reads one version, **Then** `200` with its metadata and `content: {title, description, priceMinor, brand, category, quantity, specs}`; a version id that is unknown, belongs to another draft of the same shop, or to a draft of another shop → the same `404 version_not_found`.
5. **AS-44** (snapshot unreadable) — **Given** the object store fails or the snapshot of a version is missing, **When** the version is read, **Then** `503 version_unavailable` with `Retry-After`, a generic detail (no storage message, no stack), and the failure is counted in a metric; other routes keep working.

---

### User Story 6 — Rooms are routed, durable and survive instance changes (Priority: P2)

All editors of a draft reach the same in-memory room. Scaling the editing fleet or losing an instance moves only a small share of rooms, and no edit that a client still holds is ever lost.

**Why this priority**: pattern P1105 and the notes' scale target (100,000 open drafts, ≤ 50 editors each).

**Independent Test**: unit-test the ring; run two instances against real stores and stop one.

**Acceptance Scenarios**

1. **AS-45** (consistent hashing with virtual nodes — P1105) — **Given** a ring built from the same set of instance ids in any process, **Then** every process names the same owner for every draft id; **Given** 5 instances and 10,000 draft ids, **Then** no instance owns more than 115% of the mean; **Given** a 6th instance joins, **Then** at most 1/6 + 5% of the ids change owner and every id that moved went to the new instance; **Given** an instance leaves, **Then** only its ids move; **Given** an empty ring, **Then** there is no owner. (Pure logic.)
2. **AS-46** (wrong instance) — **Given** a client reaches an instance that does not own `D` (the load balancer does not know the ring), **When** it joins with a valid ticket, **Then** the connection closes with `4001` and the owner's address as the reason, no room is loaded on the wrong instance, the ticket is **not** consumed, and reconnecting to the owner with the same ticket succeeds.
3. **AS-47** (instance leaves) — **Given** an instance with 3 open rooms, **When** it shuts down gracefully, **Then** it first leaves the ring, flushes every pending update, then closes sockets with `1012 service_restart`; clients reconnect through connect and reach the new owner; no edit is lost; **When** it crashes instead, **Then** after 15 seconds without heartbeat it drops out of every process's ring, clients reconnect, and edits made in the last 100 ms before the crash that never reached storage are recovered from the clients' own copies when they sync.
4. **AS-48** (scale out) — **Given** a 4-instance fleet with rooms open, **When** a 5th instance registers, **Then** within 5 seconds every process routes by the new ring; rooms on old instances that they no longer own flush, compact and close their sockets with `4001` plus the new owner's address within 10 seconds, with no sequence conflict; the share of moved rooms matches AS-45.
5. **AS-49** (split brain) — **Given** two instances both believe they own `D` (their ring views disagree for a moment) and both hold a room, **When** both flush updates, **Then** each log sequence number is written by exactly one of them; the loser's room closes its sockets with `4002 room_moved`, is evicted, and loses nothing because its clients reconnect to the owner and exchange state; afterwards the owner's document contains the edits made on both rooms and the log has no fork.
6. **AS-50** (durability) — **Given** an editor typing, **Then** each update is broadcast to the other editors at once (p99 under 100 ms with 50 editors) and persisted at most 250 ms later; N updates inside one 100 ms window produce one log entry; a document rebuilt from snapshot plus log equals the live one.
7. **AS-51** (compaction) — **Given** 200 log entries since the last snapshot, or an unload, **Then** the full state is stored as a snapshot, the snapshot pointer moves forward only (a compaction with a lower sequence number never moves it back), and the log entries at or below the snapshot are trimmed afterwards; **Given** a crash between moving the pointer and trimming, **Then** the leftover entries are ignored when loading and trimmed by the next compaction, and the loaded document is correct; superseded snapshots are deleted by a daily job after a 10-minute grace.
8. **AS-52** (store trouble) — **Given** the log write times out or is throttled twice and then succeeds, **Then** it is retried with exponential backoff and jitter (at most 3 attempts per cycle), the pending updates are kept, clients see no close; **Given** a write that actually succeeded but whose acknowledgement was lost, **Then** the retry finds the same sequence number already holding identical bytes and counts it as success (no `4002`); **Given** the store stays down until the unflushed backlog reaches 8 MiB or 30 seconds, **Then** writers are closed with `4013 store_unavailable` while read-only connections continue, and writes work again after reconnect once the store answers; only a genuine sequence conflict with different bytes (AS-49) evicts the room.
9. **AS-53** (large update) — **Given** a single accepted update of 400 KB (larger than one log entry may hold), **Then** it is stored as several entries of at most 300 KB each, in order, and a reload equals the live document.

---

### User Story 7 — Operate it (Priority: P3)

Operators can see room, connection, update, denial and publish health, shut instances down safely, and rely on cleanup for leftovers.

**Acceptance Scenarios**

1. **AS-54** (metrics and logs) — **Given** the activity of the earlier scenarios, **Then** the metrics endpoint shows: open rooms, connections, accepted and denied updates (by reason), flush and broadcast latency, closes by code, ring size, sequence conflicts, snapshot reads, and publish outcomes; every log line is structured JSON carrying a connection or request id plus draft, shop and user ids where known, and none contains a ticket, a document's text, or a token.
2. **AS-55** (health and shutdown order) — **Given** an editing instance, **Then** its liveness answer depends on in-process state only (it stays `200` while the stores are down); readiness is `200` only after the instance is registered in the ring; on shutdown readiness fails first, the instance leaves the ring second, pending updates are flushed third, and sockets are closed last.
3. **AS-56** (leftover cleanup) — **Given** snapshot objects of versions whose database row was never written (a failed publish, older than 1 hour) and superseded snapshots, **When** the daily job runs, **Then** unreferenced version objects and superseded snapshots are deleted and every referenced object is kept; a second run changes nothing.

### Edge Cases

Every edge case listed in the notes or found in the code has a scenario above: concurrency (AS-05, AS-14, AS-35), idempotent replay (AS-15, AS-33, AS-26), illegal transitions (AS-11, AS-34, AS-41), cross-tenant (AS-04, AS-08), limits (AS-05, AS-19, AS-41, AS-53), timeouts (AS-13, AS-20, AS-21, AS-33, AS-37, AS-38), out-of-order or duplicate events (AS-15, AS-16, AS-26), reconnect and resync (AS-17, AS-47), room moves and split brain (AS-46–AS-49), store failure (AS-52).

## Requirements *(mandatory)*

### Functional Requirements

**Drafts and access**

- **FR-001**: A draft belongs to exactly one shop for its whole life and records its creator; both come from the request context, never from the body. Every lookup of a draft or version puts the shop in the predicate, and another shop's draft is indistinguishable from an unknown one (`404 draft_not_found`) (AS-01, AS-08).
- **FR-002**: Input is validated strictly (unknown fields refused; title 1–120 characters; version name 1–80 characters without control characters); errors are `application/problem+json` with a stable machine `code` (AS-03, AS-41).
- **FR-003**: A draft may start from an existing product of the same shop; its content is read through the product command service and its product version is recorded as the base version (AS-02, AS-04).
- **FR-004**: Statuses are `DRAFT → PUBLISHING → PUBLISHED`, `PUBLISHING → DRAFT` (failure or lease expiry), and `DRAFT → ARCHIVED`. Every transition is a conditional update that asserts one affected row; an illegal transition is `409 invalid_transition` carrying `currentStatus` (AS-11, AS-34, AS-35).
- **FR-005**: A shop holds at most 200 drafts in `DRAFT` or `PUBLISHING`, enforced atomically in the store (AS-05).
- **FR-006**: The draft list is a keyset page (`updatedAt` descending, then id descending), opaque cursor bound to the shop and filter, `limit` 1–100 (default 20) (AS-07).
- **FR-007**: Every route requires a signed-in member with the permission named in AS-06, checked in the order `401`, `404`, `403 permission_denied`, then the shop status gate (`403 shop_suspended`, `409 shop_offboarding`) (AS-06).
- **FR-008**: Connect returns the owning instance's address, a ticket and the permission level; the level is write only when the member holds `products.write` and the draft is `DRAFT`; connect is rate limited per user and fails closed (AS-09, AS-10).

**Tickets and handshake**

- **FR-009**: A ticket lives 60 seconds, is signed with a key and audience dedicated to collaboration (never the session key), pins its algorithm, carries issuer, audience, expiry, a unique id, user, shop, draft and permission level, and is accepted **once**; a redirect to the owning instance does not consume it (AS-13, AS-46).
- **FR-010**: The handshake checks the ticket and the request `Origin` against an allowlist, re-reads the draft with its shop in the predicate, and only then joins the room; early frames sent before the room is ready are processed in order (AS-12, AS-13).
- **FR-011**: Tickets and document content never appear in logs, metrics labels or error bodies (AS-13, AS-54).

**Real-time editing**

- **FR-012**: Each draft's document is a conflict-free replicated document with title, description (plain text), a field map (`priceMinor` integer minor units, `brand`, `category`, `quantity`), and a spec table (text to text). Concurrent edits from any number of clients merge without loss and in any delivery order (AS-14).
- **FR-013**: Applying the same update twice has no further effect, and an update whose dependencies have not arrived is held until they do (AS-15, AS-16).
- **FR-014**: A reconnecting client exchanges state markers with the room and receives only what it lacks; its own offline edits are merged (AS-17).
- **FR-015**: Presence (cursors, names, selections) is relayed to the room, owned per member, size-capped, removed on disconnect or after 30 seconds of silence, and never persisted (AS-18).
- **FR-016**: A room accepts at most 50 connections and a user at most 5 on one draft; frames are capped at 512 KiB, document state at 2 MiB, and each connection at 200 frames per second; each limit has the exact outcome of AS-19.
- **FR-017**: Dead connections are detected by liveness pings every 30 seconds and terminated after one missed answer (AS-20).
- **FR-018**: A room is loaded once however many clients join at once, unloads 30 seconds after the last leaves (flushing and compacting first), and a join during an unload waits for it (AS-21).
- **FR-019**: Updates are broadcast at once and persisted in micro-batches of at most 100 ms (one log entry per batch, entries of at most 300 KB), with p99 broadcast under 100 ms at 50 editors (AS-50, AS-53).

**Permissions and revocation**

- **FR-020**: Write permission is checked on join and on **every** incoming update against the member's current ability; a denied write is dropped, answered with a *permission denied* message, counted, and logged without content; presence and receiving stay allowed (AS-22).
- **FR-021**: The member's ability is refreshed from the membership service (R1) on connect and by a periodic batched re-check every 60 seconds, and sooner on `tenancy.member_removed` and `tenancy.member_role_changed`; loss of read access closes the connection with `4003`, loss of write access makes it read-only; events are triggers, never grants (AS-23, AS-24, AS-26).
- **FR-022**: A shop that becomes `SUSPENDED` or enters offboarding closes its rooms (`4003 shop_inactive`) and blocks connects; `tenancy.shop_deleted` purges the shop's drafts, versions, snapshots and log entries in bounded, resumable batches (AS-25, AS-27).
- **FR-023**: Every consumer is idempotent (a processed-events record or a version-guarded effect), validates its payload strictly, and sends poison messages to the dead-letter queue (AS-26).

**Publish**

- **FR-024**: Publish requires `products.write` and an `Idempotency-Key`; it claims the draft with a conditional `DRAFT → PUBLISHING` update carrying a 60-second lease; of simultaneous publishes exactly one proceeds (AS-33, AS-35).
- **FR-025**: Before reading the final content, publish freezes the room through its owning instance: updates received before the freeze are included, later ones are refused; if the owner cannot confirm within 3 seconds the publish fails and the draft returns to `DRAFT` (AS-38).
- **FR-026**: Publish applies the content through the product command service (create when the draft has no product; update with `expectedVersion` = the draft's base version, or the version the publisher acknowledged, otherwise), sending only changed fields, and completes the draft's transition, the version row and the outbox events in **one** transaction; no network call happens inside it (AS-28–AS-30).
- **FR-027**: Content is validated before publish with the product limits of S05; problems are `422 listing_invalid` with `{field, code}` per problem (AS-31).
- **FR-028**: A failed publish releases the claim and leaves the draft editable; an expired lease is reclaimed by a job, and a publisher that lost its lease cannot complete (AS-36, AS-37).
- **FR-029**: Publish emits `catalog.draft_published` and (through the product update path) the product event, both in the publish transaction (AS-28, AS-29).
- **FR-030**: The spec table is rendered into the description as a "Specifications" section and parsed back when a draft is created from a product; the two operations are exact inverses (AS-39).

**Versions**

- **FR-031**: A named version is an immutable snapshot of the room state after a flush barrier; at most 200 per draft; listing is a keyset page; reading returns the content; publishing adds a `published` version (AS-40–AS-43).
- **FR-032**: A snapshot that cannot be read yields `503 version_unavailable`, never a stack trace or storage message (AS-44).

**Routing and durability**

- **FR-033**: Room ownership is decided by consistent hashing with virtual nodes over the live instances (256 per instance); every process computes the same owner from the same member list; instances join on start, leave on graceful stop, and expire after 15 seconds without heartbeat (AS-45, AS-47).
- **FR-034**: An instance that does not own a draft refuses the join with `4001` and the owner's address, without consuming the ticket; after a ring change an instance flushes, compacts and closes rooms it no longer owns (AS-46, AS-48).
- **FR-035**: Durable state is a snapshot plus an ordered update log; log writes are conditional on the sequence number so two writers can never fork the log; a genuine conflict evicts the loser room (`4002`), an identical-bytes conflict is a successful retry (AS-49, AS-52).
- **FR-036**: Compaction stores a snapshot, moves the pointer forward only, then trims the log; superseded snapshots are removed by a job after a grace period (AS-51).
- **FR-037**: Transient store failures are retried (at most 3 attempts per cycle, exponential backoff with full jitter), never drop pending updates, and degrade writers only after the 8 MiB / 30 s backlog limit (AS-52).
- **FR-038**: Every store, cache and queue call has an explicit timeout; graceful shutdown follows the order of AS-55 (AS-55).

**Boundaries and operations**

- **FR-039**: The capability reads product content only through the product command service and membership only through the membership services (R1); it holds no foreign key and no query to another domain's table; the draft tables, update log and snapshots are owned by `catalog` (constitution IX).
- **FR-040**: Metrics, structured logs and health follow AS-54 and AS-55; leftover objects are cleaned by the jobs of AS-37 and AS-56, each single-run and idempotent.
- **FR-041**: Every endpoint has request and response schemas in `packages/contracts`, and the e2e specs parse responses with them (AS-01–AS-44).

### Key Entities

- **Listing draft**: a working copy of one listing, owned by one shop; has a label (title), a status, an optional target product with the product version it started from, a creator, timestamps, a pointer to its latest snapshot and the sequence number that snapshot covers, and (while publishing) a lease.
- **Draft document**: the collaboratively edited content (title, description, price in minor units, brand, category, quantity, spec table). Lives in the room, the update log and snapshots; not a table row.
- **Update log**: ordered, append-only entries of merged document updates per draft, trimmed after compaction. Owned by `catalog`.
- **Snapshot**: the full document state at a log sequence number, stored as an object.
- **Draft version**: an immutable named or `published` snapshot of a draft with creator and time.
- **Room**: the in-memory live document of one draft on its owning instance, with its members and presence.
- **Ticket**: a one-use, 60-second proof of access to one draft at one permission level.
- **Editing instance and ring**: a process hosting rooms, registered in a shared member list with a heartbeat; the ring of registered instances decides ownership.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With 50 editors typing in one draft, 99% of edits are visible to every other editor within 100 ms.
- **SC-002**: In every convergence scenario (concurrent, duplicate, out-of-order, offline) all editors and the stored state end identical — 100% of runs, zero lost or duplicated characters.
- **SC-003**: A removed or demoted member can no longer change a draft within 5 seconds in normal operation and within 65 seconds when the instant notification is lost.
- **SC-004**: A publish with a typical draft (≤ 20 KB document) completes in under 2 seconds at the 95th percentile and creates exactly one product change however many times or how concurrently it is requested.
- **SC-005**: A planned restart of an editing instance loses zero edits; after a crash, edits are recovered from clients in 100% of reconnects that still hold them.
- **SC-006**: Adding one instance to a fleet of N moves at most 1/(N+1) + 5% of open rooms; no instance carries more than 115% of its fair share.
- **SC-007**: The design supports 100,000 concurrently open drafts at up to 50 editors each, about 5,000 rooms per instance, and 20,000 updates per second fleet-wide.
- **SC-008**: Zero cross-tenant reads or writes succeed in the IDOR scenarios (AS-04, AS-08, AS-24, AS-27), and no ticket or document text appears in any log.
- **SC-009**: No request of this capability ever waits more than its documented timeout for a store, cache or queue (publish freeze 3 s, ticket 60 s, lease 60 s).

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains` for `S06` and `catalog`; `specs/web` and `specs/journeys` do not exist yet): **S05** requires that S06 publishes a revision only through `ProductCommandService.update` (its `gaps.md` A23 and `questions.md`), and **S03** requires that S06 stops reading `ShopMembership` and uses `ShopAccessService.assertMember` / `getRole`. Both are honoured (FR-021, FR-026, FR-039). Where S06 needs an addition from them it is a `[CONTRACT]` line in `questions.md`.

**Provides** (exact names):

- HTTP under `/api`, problem+json errors with `code`, schemas in `packages/contracts`: `draftSchema`, `draftPageSchema` (`{items, nextCursor}`), `draftCreateRequestSchema`, `draftConnectSchema` (`{url, ticket, canWrite, expiresAt}`), `draftVersionSchema` (`{id, name, kind: 'named' | 'published', createdBy, createdAt}`), `draftVersionDetailSchema` (version plus `content: {title, description, priceMinor, brand, category, quantity, specs}`), `draftVersionPageSchema`, `draftVersionCreateRequestSchema` (`{name}`), `draftPublishRequestSchema` (`{acknowledgeProductVersion?: integer}`), `draftPublishResultSchema` (`{productId, productVersion, versionId}`), `draftEventSchemas`:
  - `POST /shops/:shopId/drafts` (`products.write`) → `201 draftSchema`; `GET /shops/:shopId/drafts?status&limit&cursor` (`products.read`) → `draftPageSchema`.
  - `POST /shops/:shopId/drafts/:draftId/connect` (`products.read`) → `200 draftConnectSchema`.
  - `POST /shops/:shopId/drafts/:draftId/archive` (`products.write`) → `200 draftSchema`.
  - `GET /shops/:shopId/drafts/:draftId/versions?limit&cursor` (`products.read`) → `draftVersionPageSchema`; `GET .../versions/:versionId` → `draftVersionDetailSchema`; `POST .../versions {name}` (`products.write`) → `201 draftVersionSchema`.
  - `POST /shops/:shopId/drafts/:draftId/publish` (`products.write`, header `Idempotency-Key` required, body `{acknowledgeProductVersion?}`) → `200 draftPublishResultSchema`.
  - Error codes: `validation_failed`, `invalid_cursor`, `shop_not_found`, `draft_not_found`, `product_not_found`, `product_archived`, `version_not_found`, `permission_denied`, `shop_suspended`, `shop_offboarding`, `invalid_transition`, `publish_in_progress`, `product_version_conflict` (with `currentVersion`), `draft_limit_reached`, `version_limit_reached`, `listing_invalid` (with `errors`), `idempotency_key_required`, `idempotency_key_invalid`, `idempotency_key_reuse`, `request_in_flight`, `collab_unavailable`, `version_unavailable`.
- Editing connection (consumed by **W04**): `wss://<instance>/collab/<draftId>?ticket=<ticket>` speaking the standard y-websocket binary protocol (sync, awareness, permission-denied messages). Document schema: text `title`, text `description`, map `fields` (`priceMinor`, `brand`, `category`, `quantity`), map `specs`. Close codes: `1001 room_closed`, `1009` too large, `1012 service_restart`, `4000 protocol_error`, `4001` wrong instance (reason = owner address; reconnect there with the same ticket), `4002 room_moved` (call connect again), `4003 access_revoked | shop_inactive`, `4004 draft_not_found`, `4005 draft_closed` (call connect; you will be read-only), `4008 room_full | too_many_connections`, `4009 document_too_large`, `4013 store_unavailable`, `4029 rate_limited`. Clients reconnect with exponential backoff plus jitter and resume by state exchange.
- Event `catalog.draft_published` v1 (outbox → topic `drafts.events`, key `draftId`; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; payload `{draftId, shopId, productId, productVersion, versionId, publishedBy}`); no consumer at this time.
- Modules for the apps (exported from `@app/domains/catalog`): `DraftsModule` (core: HTTP), `CollabModule` (collab app: rooms and the connection server), `DraftsProjectorModule` (projector or worker: tenancy event consumers, jobs). Nothing else is exported.
- Scheduled jobs (registered with S49): `drafts.release-stale-publishing` (every minute), `drafts.purge-superseded-snapshots` (daily; also removes unreferenced version objects).
- Rate-limit policies (declared in S50's registry): `catalog.draft-connect.user` 30/minute per user (fail closed); `catalog.draft-write.shop` 120/minute per shop for create, archive and version create (fail closed); `catalog.draft-publish.shop` 10/minute per shop (fail closed).

**Requires**:

- **S05** (`catalog`, same domain, in-process): `ProductCommandService.getForShop(shopId, productId)` returning the member view `{id, shopId, title, description, brand, category, priceMinor, currency, quantity, status, version, …}`; `create(shopId, actorId, input)` and `update(shopId, productId, input & { expectedVersion })` where `input` fields are `title, description, brand, category, priceMinor, currency, quantity`; errors `ProductNotFoundError`, `VersionConflictError` (with `currentVersion`), `ProductArchivedError`, `ShopNotActiveError`; **additions asked for** (see `questions.md`): join the caller's open transaction, throw `ProductValidationError { issues: { field, code }[] }` for the S05 limits, and report an unchanged update as an unchanged outcome with the current version.
- **S03** (`tenancy`): `ShopScoped(permission)` on every draft route with the order of AS-06; `ShopAccessService.assertMember(shopId, userId, permission?)` → `{ role }` (throws not-found or forbidden) and `getRole`; `MembershipQueryService.getMembersByShopIds(shopIds ≤ 500)` → `Map<ShopId, {userId, role}[]>`; **addition asked for**: an exported pure `roleHasPermission(role: ShopRole, permission: ShopPermission): boolean`; events `tenancy.member_removed` v1 `{shopId, userId, role, reason}`, `tenancy.member_role_changed` v1 `{shopId, userId, from, to}`, `tenancy.shop_status_changed` v1 `{shopId, from, to, reason?, shopVersion}`, `tenancy.shop_offboarding_started` (with `shopId`), `tenancy.shop_deleted` (with `shopId`).
- **S01** (`identity`): `Firewall`, `@User()`, `AuthenticatedUser = {id, role, sessionId, amr}`.
- **S53**: `outbox.append(event)` inside the domain's transaction; the consumer framework (envelope check, strict validation, inbox or version guard, dead-letter queue).
- **S54**: problem+json filter with `code`, request context with `requestId`, the shared `Idempotency-Key` facility (replay, in-flight `409`, reuse `422`, TTL 24 h), config validation (collab public URL, instance id, ticket key, origin allowlist), metrics registry, graceful-shutdown ordering, health probes.
- **S49**: single-run scheduled jobs. **S50**: the policies above.
- **S52 / infrastructure**: shared cache and Redis clients with timeouts; an instant-notification backplane over Redis pub/sub (best effort only; AS-24 carries the guarantee).
- **W04**: the editor screen that consumes the Provides above (see `questions.md`).

## Assumptions

All defaults are also in `questions.md`.

- This is a showcase with no external clients: where the notes and the constitution support a stricter option, the stricter option is specified even though it changes today's behaviour (all `[BREAKING]`).
- Document content is plain text in this version; rich-text formatting, images and comments are out of scope. Restoring an old version into the live draft is out of scope (a member can read a version and copy from it).
- The draft's label (`title`) is independent of the document's title; the label is for lists only.
- Platform currency is implied: the draft stores `priceMinor` only and publish passes the platform currency.
- Existing draft documents that used the key `price` are not migrated (no production data); the new key is `priceMinor`.
- Limits: 200 open drafts per shop, 200 versions per draft, 50 connections per room, 5 per user per draft, 512 KiB per frame, 2 MiB per document, 200 frames/s, 8 KiB per presence frame, 60 s ticket, 60 s publish lease, 3 s freeze timeout, 100 ms flush, 200 flushes per compaction, 30 s idle unload, 30 s presence silence, 15 s instance heartbeat expiry, 60 s membership re-check.
- Published and archived drafts are kept until the shop is deleted (their versions are the history).
- Draft contents are not part of the shop offboarding export (published content is in products); at offboarding, drafts freeze, and at deletion they are purged.
- A seller account's permissions come from S03's roles (`products.read`, `products.write`).
