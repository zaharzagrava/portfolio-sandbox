# Questions and unattended decisions: S24 — Product chat (domain `chat`)

Decided without asking (policy: the most production-grade option the notes and the constitution support). BREAKING first, then CONTRACT, then LOCAL. `[BREAKING]` means existing tests or callers change.

## BREAKING

- [BREAKING] Who may read a channel's history, its metadata by ID, and its sync entries → active members only; strangers get `404 channel_not_found`; only `GET /chat/channels/by-product/:productId` (public fields) stays open to any signed-in user → today any signed-in user reads any channel's messages (`chat.service.ts:201-221`) and metadata (`:153-166`), an IDOR; V.4 and III.4.
- [BREAKING] Channel creation authority → a member of the product's shop with `products.write` (S03 R1 `assertMember`), product from S05 R1 `getProductsByIds`; channel records `shopId` → today `product.sellerId === userId` through catalog's `ProductDtoService` (`chat.service.ts:82-90`) and the `ChatChannel → Product/User` associations; IX.4 and S03/S05 contracts.
- [BREAKING] Second channel for a product → `409 channel_exists` (was `400` `BadRequest`, `chat.service.ts:117-121`); archived product → `409 product_archived` → V.4 state conflicts are `409`.
- [BREAKING] Moderation authority → live shop membership with `products.write` ("manager") plus stored `MODERATOR`; the stored `OWNER` role no longer confers authority by itself → a person who left the shop must lose control at once (`chat.service.ts:174,327` check the stored role only).
- [BREAKING] Idempotency key scope and conflicts → key is `(channel, author, clientMessageId)`; identical replay `200 duplicate: true`; different content `422 idempotency_key_reuse`; another author's same ID creates their own message → today the unique key is `(channel, clientMessageId)`, a replay answers `201`, different content silently returns the original, and a foreign reuse answers `403` that confirms the other message exists (`chat-sync.service.ts:63-70`); V.6 and the notes (client IDs → idempotent insert).
- [BREAKING] Send refusals → archived `409 channel_archived` (was `403`), banned `403 banned`, muted `403 muted` + `mutedUntil`, stranger `404`, invalid reply target `422 reply_target_invalid` (was an unhandled foreign-key `500`) → distinct, testable codes (`chat-sync.service.ts:208`).
- [BREAKING] A member's own messages are never unread for them: posting advances their read position → today `unread` counted the seller's own 5 messages as 5 unread (`chat-sync.e2e-spec.ts:102` asserts it) and would trigger pointless pushes to authors; WhatsApp/Slack behaviour.
- [BREAKING] `GET /chat/unread` → `{items, nextCursor}` keyset pages (`limit` 1–200, default 50) → today a bare array silently truncated at 200 (`chat-sync.service.ts:134`); III.10. W05 and `packages/web/lib/api/chat.ts:42` change.
- [BREAKING] `GET /chat/channels/:id/messages` → `{items, nextCursor}`, opaque cursor, newest first by sequence, tombstones included, `limit` 1–100 → today a bare array, `before` = message ID, deleted rows hidden so a client sees a gap (`chat.service.ts:216-220`, `chat-message.model.ts:53`); III.10.
- [BREAKING] Sync input handling → more than 50 channels `400 too_many_channels`; bad UUID/negative/fractional cursor `400` → today silently truncated to 50 and invalid entries silently dropped (`chat-sync.service.ts:89`, `chat-sync.controller.ts:39`), which hides client bugs and loses channels.
- [BREAKING] Deleted message bodies in sync → never served after the delete commits (no 30-second stale window) → today the recent-window cache can serve a deleted body for up to 30 s (`chat-sync.service.ts:195-196`); a moderation delete is a safety action.
- [BREAKING] `GET /chat/presence` → only users who share an active channel with the caller (others look offline); malformed or more than 100 IDs `400`; store down `503 presence_unavailable` → today anyone can poll any user ID for online status and invalid IDs are dropped silently (`chat-sync.controller.ts:64-69`); privacy.
- [BREAKING] Moderation → `204` (was `201 {success:true}`); illegal repeats `409 invalid_transition`; target must already be a member, else `404 member_not_found` (today `ensureMember` creates a membership for any UUID, `chat.service.ts:257,280,304,333`); strictly higher rank also governs deleting another's message; `unmute` and `demote` endpoints added → VII.3 and V.4.
- [BREAKING] Offline push → emits `chat.message_escalated` (outbox) instead of calling `NotificationRouter.dispatch`; the sender label (e-mail local part from a `User` join) is removed → `chat-offline.ts:88,96-103` reads `"User"` (D-12) and puts an e-mail fragment in a push; domain-map: "notifications (offline escalation via event)".
- [BREAKING] `chat.message_posted` emission → derived from the message rows by change-data-capture; the trigger stops writing to the `Outbox` table → `20261001260000-chat-sequences.js:48-55` writes another owner's table from a chat function (IX.4 "triggers referencing another owner's table", IX.6). If CDC is not deployed yet, the trigger stays as a dated Complexity-Tracking exception.
- [BREAKING] Read receipts and presence broadcasts are suppressed in channels with more than 50 active members → notes ("huge channels: lightweight unread notifications instead of pushing everything"); today a 5,000-member channel would get a receipt storm.
- [BREAKING] Malformed IDs in paths → `400 validation_failed` on every route (`ParseUUIDPipe`); today several routes reach the database (`chat.controller.ts:62-76,88-96`).
- [BREAKING] New `429` limits on send, sync, read, heartbeat, presence, channel create and ticket → V.2 and the notes' reconnect-storm guidance; existing e2e specs that loop requests must stay below them.
- [BREAKING] Barrel `@app/domains/chat` stops exporting `ChatChannelModel`, `ChatChannelMemberModel`, `ChatMessageModel` and `ChatOfflineScheduler`; adds `ChatProjectorModule` → D-7, D-8; callers (tenancy backfill job, `core.module.ts`, `projector.module.ts`) switch.
- [BREAKING] Archiving an archived channel (or unarchiving an active one) → `409 invalid_transition` → today it silently succeeds (`chat.service.ts:180-189`); V.4.

## CONTRACT

- [CONTRACT] S01 lists S24 as a consumer of `UserDirectoryService.getUsersByIds` (user display) → S24 does not consume it: no author name is published and moderation needs no existence check → S01 may drop S24 from its consumer list; if S01 later adds a public display name it is shown by composition (R2, S48/W05), not stored in chat.
- [CONTRACT] Who emits the push request → S24 emits `chat.message_escalated` v1 `{recipientId, channelId, channelTitle, messageId, seq, authorId, preview, dedupeKey}` (outbox, topic `chat.events`, key `recipientId`); S28 consumes it, deduplicates on `dedupeKey` and applies preferences, quiet hours and caps; type `chat.message` in category `chat` stays → S28 is not written yet; fixes the event the notes' "notify after 30 s undelivered" needs and honours domain-map.
- [CONTRACT] Shop authority → S03 `ShopAccessService.assertMember(shopId, userId, 'products.write')` (R1) called on every manager action; S24 does not cache the answer → S03 AS-21/AS-25 revoke membership immediately; stale authority is a security bug.
- [CONTRACT] Shop lifecycle → S24 consumes `tenancy.shop_deleted` v1 `{shopId}` and purges (S03 states every shop-owning domain does its own purge); `tenancy.shop_offboarding_started` is not consumed (no export of other people's messages).
- [CONTRACT] Shop-id backfill → S24 owns it, batches ≤ 200 via `ShopProvisioningService.ensureShopsForLegacySellers` plus `getProductsByIds` for the product's shop, then makes `ChatChannel.shopId` required; tenancy deletes its raw `UPDATE "ChatChannel"` job → S03 questions line 23/45 and gaps A22.
- [CONTRACT] Product lookup → S05 `getProductsByIds([productId])` returning `{id, shopId, title, status}`; archived product refuses channel creation → S05 spec lists S24 as a consumer.
- [CONTRACT] Realtime hub → topic prefix `chat` registered through `TopicRegistry.define` with an active-members policy; events `read` and `presence` published with `replay: false` → S51 must keep `chat:` as an allowed topic prefix (`topic-registry.spec.ts:7,19` already assert it).
- [CONTRACT] Queue and event infrastructure (S53) → delayed single-consumer tasks with a `dedupeId` (identity `(eventId, recipientId)`), inbox/DLQ consumers, and change-data-capture or trigger-free emission for rows written by the Rust gateway → needed for AS-42, AS-46, AS-20.
- [CONTRACT] Rate-limit policy names and values (S50): `chat.send.user`, `chat.sync.user`, `chat.read.user`, `chat.heartbeat.user`, `chat.presence.user`, `chat.channel-create.user`, `chat.ws-ticket.user`, all fail open.
- [CONTRACT] Gateway compatibility (Rust, D1) → the three gateway statements stay valid and gateway-written rows get their sequence and event from the system of record; gateway pushes may lack `seq`; W05 must treat pushes as hints and sync on every (re)connect with jittered back-off → the Rust service is out of scope and untouched.
- [CONTRACT] W05 client → must generate `clientMessageId` once per user action and reuse it on every retry (today `chatApi.send` makes a new UUID per call, `packages/web/lib/api/chat.ts:48-49`, so a retried call duplicates), keep per-channel highest `seq`, and sync after every reconnect → idempotency only works if the client reuses the ID.
- [CONTRACT] Contracts package → `packages/contracts` adds the nine chat schemas named in the spec (V.2); W05 imports them instead of `lib/api/chat.ts` hand-written types.

## LOCAL

- [LOCAL] Channel metadata fields → add `shopId` (additive), keep `sellerId` = creating user → web and gateway already read it.
- [LOCAL] Sequence assignment stays inside the database for every writer → the gateway cannot call the app; unique index remains `(channelId, seq)` or its partition-aware equivalent.
- [LOCAL] Idempotency store under monthly partitioning → a small chat-owned dedupe table (or equivalent) keyed `(channelId, authorId, clientMessageId)`; plan decides, AS-28 is the test → a partitioned table cannot enforce cross-month uniqueness.
- [LOCAL] Message primary key under partitioning → `(id, createdAt)`; the gateway's statements and `RETURNING` lists are unaffected → verified by AS-58.
- [LOCAL] Partition window → current month + 3 ahead, default partition as safety net with an alert counter → AS-29.
- [LOCAL] Recent-messages window cache → content-addressed by `(channel, lastSeq)`; a delete evicts the affected keys (AS-26).
- [LOCAL] Presence key per user with 60 s TTL; first-heartbeat detection by an atomic set-and-get; broadcast list = 20 most recent channels → as today.
- [LOCAL] Presence lookups use one multi-get plus one co-membership query (users ∩ caller's channels), never one query per ID.
- [LOCAL] Small-channel threshold 50 → a denormalized active-member count on the channel kept in the membership transactions.
- [LOCAL] Offline check identity `(eventId, recipientId)`; coalescing key `(recipient, channel)` 300 s; the slot is taken only after the event is appended and released if the append fails → AS-47.
- [LOCAL] Scheduler batch size ≤ 50 recipients per event (the threshold) → one `enqueueBatch` per event.
- [LOCAL] Delete is idempotent `204`; state toggles are `409` → HTTP semantics vs V.4.
- [LOCAL] Mute duration 1–43,200 minutes as today; `unmute` and `demote` added to match the existing event enums.
- [LOCAL] `editedAt` is unused; the plan may drop it (expand/contract).
- [LOCAL] WS ticket stays a 60-second signed credential with `typ: "ws"`; key management stays with S01/S54 configuration.
- [LOCAL] Log lines carry channel, message and user IDs and body length only.
