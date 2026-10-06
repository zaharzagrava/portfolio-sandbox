# Feature Specification: S24 — Product Chat (channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push) — domain `chat`

**Feature Branch**: `S24-product-chat` (spec directory `specs/domains/S24-product-chat`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Capability S24 — Product chat: channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push (domain `chat`)." Sources: `docs/showcase/sections/SD-14-chat-guarantees.md`; repository `README.md` (chat gateway sections); note `10-System-Design/06-realtime-and-collaboration.md` §14 (chat app); constitution v3.1.0; `docs/architecture/domain-map.md` (`chat`); `docs/architecture/pattern-map.md` rows P0318 (table partitioning, chat monthly) and P0607 (per-key ordering), the two rows naming S24; the current code of `packages/backend/libs/domains/chat/` and its two e2e specs; the already-written specs S01, S03, S05, S23 that name chat or S24.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (constitution VII.8 table), [`gaps.md`](gaps.md) (what today's code lacks, debt rows, IX.7 replacements).

## Scope

In scope:

- **Channels**: one chat per product. The shop that owns the product opens it; any signed-in buyer joins it; members can be moderated (ban, unban, mute, unmute, promote, demote); a channel can be renamed and archived; a member's own messages can be deleted and moderators can delete others'.
- **Messages**: plain-text messages with an optional reply reference, sent over HTTP with a client-generated message ID so a retry never duplicates. Every stored message gets a **per-channel sequence number** that is gap-free and strictly increasing, whoever wrote it (this API or the realtime gateway).
- **Sync on reconnect**: a client sends, per channel, the highest sequence it has and receives exactly what it missed. Live push is best-effort; sync is the delivery guarantee. History scroll-back is a separate paged read.
- **Unread and read receipts**: per member and channel, `unread = latest sequence − last read sequence`; marking read is monotonic and capped; the advance is announced to the channel's members.
- **Presence**: a heartbeat marks a user online for 60 seconds; the offline → online transition is announced to the channels that matter; presence is ephemeral and never stored in the primary database.
- **Offline push**: a recipient who has neither read a message nor shown up online 30 seconds after it was posted is escalated once per channel per 5 minutes, through an event the notification capability consumes.
- **History storage**: the message history is partitioned by month (P0318) and its uniqueness guarantees survive partition boundaries.
- **Event contract**: every stored message produces exactly one `chat.message_posted` event, keyed by channel so per-channel order is kept (P0607).
- **Shop lifecycle**: when a shop is deleted, its channels and messages are purged.

Out of scope (owners named):

- The realtime WebSocket gateway (connect, subscribe, fan-out of live messages, typing indicators) → separate Rust service, untouched (decision D1). This capability only keeps its table and bus formats compatible (see Cross-capability contracts, "Gateway compatibility").
- Notification delivery itself (channel choice, quiet hours, preferences, caps, templates) → **S28** (`notifications`). Chat only emits the escalation event.
- The realtime push hub (topic registry, SSE connections, replay) → **S51**. Rate-limit engine → **S50**. Job scheduler → **S49**. Outbox, change-data-capture, queues, consumer framework → **S53**. Problem+json filter, config validation, metrics, health, graceful shutdown → **S54**. Cache toolkit → **S52**.
- Shop membership and roles → **S03** (`tenancy`). Product data → **S05** (`catalog`). Authentication and sessions → **S01** (`identity`). Chat uses them only through the mechanisms named under Cross-capability contracts.
- Live-stream comments (high-volume, lossy, sampled) → **S23**. Product chat is durable and per-channel ordered.
- Message editing, attachments and media, reactions, typing indicators, end-to-end encryption, full-text message search, direct (1:1) conversations outside a product, forwarding. Not offered (see Assumptions).
- The web screens → **W05**. This capability gives W05 the HTTP and event contract; the one UI journey lives in W05's journey spec (see `test-plan.md`).

## Clarifications

Decided unattended; each is also in [`questions.md`](questions.md), BREAKING and CONTRACT first.

- Access to a channel's messages, read state and receipts requires an active membership; a stranger gets `404`, never `403`, so channel existence is not revealed (V.4). Today a non-member can read any channel's history.
- A message's idempotency key is `(channel, author, clientMessageId)`. Replaying it with the same content returns the original (`200`, `duplicate: true`); replaying it with different content is `422`; someone else's reuse of the same ID creates their own message and discloses nothing.
- A member's own message never counts as unread for them: posting moves their read position to that message.
- Presence is visible only between users who share at least one active channel; anyone else looks offline.
- The author's e-mail is never part of a push; the escalation event carries the channel title and a text preview and no author name.
- Moderation authority over a channel belongs to the owning shop's staff (live check of shop membership with `products.write`) and to members promoted to moderator inside the channel.
- Large channels (more than 50 active members) behave like forums: no per-message push, no read-receipt or presence broadcasts.

## User Scenarios & Testing *(mandatory)*

Every acceptance scenario has a stable ID `AS-nn`; `test-plan.md` maps each to exactly one row. Defaults referenced below are listed under *Defaults* in Requirements. Errors are `application/problem+json` with a stable `code`.

### User Story 1 — A shop opens a chat for a product and buyers join it (Priority: P1)

A seller opens the chat for one of their products. Buyers find it from the product page and join. Only members see what is said; strangers learn nothing, not even that the chat exists beyond its public title.

**Why this priority**: nothing else works without channels and the membership wall that protects every later read.

**Independent Test**: create a channel as shop staff, join as a buyer, then try to read it as an outsider.

**Acceptance Scenarios**:

1. **AS-01** — **Given** a signed-in member of a shop with the `products.write` permission and an `ACTIVE` product of that shop, **When** they `POST /api/chat/channels {productId, title?}`, **Then** `201` with `{id, productId, shopId, sellerId, title, isArchived: false, archivedAt: null, createdAt, updatedAt, myRole: "OWNER"}` where `shopId` is the product's shop, `sellerId` is the caller, and `title` is the product title when omitted; one channel row exists with sequence counter `0`, and one membership `(channel, caller, OWNER, ACTIVE)` exists.
2. **AS-02** — **Given** the create route, **When** it is called without credentials, **Then** `401`; **When** the caller is a signed-in user who is not a member of the product's shop, or a member without `products.write`, or a member of a different shop, **Then** `403 permission_denied` and nothing is stored; **When** the product does not exist, **Then** `404 product_not_found`.
3. **AS-03** — **Given** a product that already has a channel, **When** staff create another, **Then** `409 channel_exists` and the first channel is untouched; **Given** no channel, **When** two staff members create one for the same product at the same time, **Then** exactly one `201` and one `409 channel_exists`, one channel row and one `OWNER` membership exist.
4. **AS-04** — **Given** the create route, **When** `productId` is missing or not a UUID, `title` is empty, longer than 120 characters, or not a string, or the body carries an unknown field, **Then** each case returns `400 validation_failed` and nothing is stored; **Given** an `ARCHIVED` product, **Then** `409 product_archived`.
5. **AS-05** — **Given** an open channel and a signed-in buyer, **When** they `POST /api/chat/channels/:channelId/join`, **Then** `200` with the channel and `myRole: "MEMBER"` and one membership `(channel, buyer, MEMBER, ACTIVE, lastReadSeq = channel's current sequence)` — a joiner starts with no unread backlog; **When** they join again, or ten simultaneous joins arrive, **Then** every response is `200`, exactly one membership row exists and its read position is unchanged.
6. **AS-06** — **Given** a member banned from the channel, **When** they join, **Then** `403 banned` and their status stays `BANNED`; **Given** an archived channel, **Then** `409 channel_archived` and no membership is created; **Given** an unknown channel `404 channel_not_found`; **Given** a malformed channel ID `400 validation_failed`; **Given** no credentials `401`.
7. **AS-07** — **Given** a channel and a user who is not a member, **When** they `GET /api/chat/channels/:channelId`, **Then** `404 channel_not_found`; **When** a member does, **Then** `200` with their `myRole`; **When** any signed-in user calls `GET /api/chat/channels/by-product/:productId`, **Then** `200` with the same shape and `myRole: null` for a non-member (the discovery route returns only the public fields above, no member list, no counters), and `404 channel_not_found` when the product has no channel.
8. **AS-08** — **Given** an `ACTIVE` channel, **When** shop staff with `products.write` send `PATCH /api/chat/channels/:channelId {title?, isArchived?}`, **Then** `200` with the new title and/or `isArchived: true` with `archivedAt` set to the clock, and a `channel_archived` event is published on the channel's live bus after commit; **When** `isArchived: true` is sent to an archived channel, or `false` to an active one, **Then** `409 invalid_transition` and nothing changes; **When** `isArchived: false` is sent to an archived channel, **Then** `200`, `archivedAt: null`; **When** the caller is a member without manager authority (FR-031), **Then** `403 permission_denied`; **When** a stranger, `404 channel_not_found`; **When** `title` is empty or longer than 120 characters or the body is empty, **Then** `400 validation_failed`.

### User Story 2 — Send a message exactly once, in order (Priority: P1)

A buyer sends a question over a flaky mobile connection. The app retries with the same client message ID. The seller sees one message, in the right place, and so does every other member — and the order is the same for everyone because the server, not any clock, decides it.

**Why this priority**: duplicate or reordered messages destroy trust in chat; this is the heart of the capability (P0607 and the notes' sequence + client-ID design).

**Independent Test**: send the same request ten times at once and read the channel back.

**Acceptance Scenarios**:

1. **AS-09** — **Given** a channel whose last sequence is 4 and an active member, **When** they `POST /api/chat/channels/:channelId/messages {clientMessageId, body: "Is it unlocked?"}`, **Then** `201 {message: {id, seq: 5, authorId, body, replyToId: null, createdAt, deleted: false}, duplicate: false}`; one message row exists; the channel's last sequence is 5; one `chat.message_posted` event exists (AS-20); the message was published on the channel's live bus.
2. **AS-10** — **Given** the message of AS-09, **When** the identical request (same `clientMessageId`, `body`, `replyToId`) is sent again, **Then** `200 {message: <the same id, seq, createdAt>, duplicate: true}`; still one row, last sequence still 5, no second event, no second live publish.
3. **AS-11** — **Given** the message of AS-09, **When** the same `clientMessageId` is sent with a different `body` or a different `replyToId`, **Then** `422 idempotency_key_reuse` and the stored message is unchanged.
4. **AS-12** — **Given** the message of AS-09 by member A, **When** member B sends a message with the same `clientMessageId` to the same channel, **Then** `201` with B's own message and its own sequence 6 and A's message is untouched; **When** A sends the same ID to a different channel they are in, **Then** `201` and a separate message; no response ever discloses another member's message or key.
5. **AS-13** — **Given** an empty channel, **When** the same request (same `clientMessageId`) is sent ten times simultaneously, **Then** exactly one row exists; every response carries the same `message.id` and `seq`; exactly one response has `duplicate: false` and status `201`, the rest `duplicate: true` and status `200`; the sequence is 1.
6. **AS-14** — **Given** an empty channel with two members, **When** 20 distinct messages are sent simultaneously, mixing the HTTP route and direct inserts the way the realtime gateway does (no sequence and no `clientMessageId` supplied), **Then** the stored sequences are exactly `1..20` with no gap and no duplicate, each message has a distinct sequence, and 20 `chat.message_posted` events exist.
7. **AS-15** — **Given** a channel at sequence 3, **When** a message with a `replyToId` that does not exist in this channel (unknown, or a message of another channel) is sent, **Then** `422 reply_target_invalid`, nothing is stored, and the next valid message gets sequence 4 (a rejected write leaves no gap and consumes no sequence); **When** `replyToId` is a deleted message of this channel, **Then** `201` (a tombstone is a valid target).
8. **AS-16** — **Given** the send route, **When** `body` is missing, not a string, empty, whitespace only, or 4,001 characters (a character is one Unicode code point), `clientMessageId` is missing or not a UUID, `replyToId` is present and not a UUID, or the body carries an unknown field, **Then** each case returns `400 validation_failed` and nothing is stored; **When** `body` is exactly 4,000 characters, **Then** `201`; leading and trailing whitespace is trimmed before storing.
9. **AS-17** — **Given** the send route, **When** the caller has no credentials, **Then** `401`; **a stranger** `404 channel_not_found`; **a banned member** `403 banned`; **a member muted until a future instant** `403 muted` with `mutedUntil` in the problem body and nothing stored; **the same member once the frozen clock passes `mutedUntil`** `201`; **an archived channel** `409 channel_archived`; **a malformed channel ID** `400 validation_failed`.
10. **AS-18** — **Given** the per-user send limit of 10 messages per 10 seconds, **When** a member sends an 11th within the window, **Then** `429 rate_limited` with `Retry-After`, nothing stored, and other members are unaffected; **Given** the limiter's store is down, **Then** sends are accepted (fail open) and `chat_limiter_unavailable_total` increases by 1.
11. **AS-19** — **Given** the live bus is unreachable, **When** a member sends a message, **Then** `201`, the message is stored, and `chat_push_failed_total{kind="message"}` increases by 1; the next sync returns the message (the push is best-effort, the sync is the guarantee).
12. **AS-20** — **Given** any stored message, whichever writer inserted it, **Then** exactly one `chat.message_posted` v1 event exists for it with `aggregateId = channelId`, `version = seq`, and payload `{channelId, messageId, seq, authorId, preview}` where `preview` is the first 120 characters of the body; **Given** 20 messages in one channel, **Then** the events appear on the event stream in sequence order for that channel (the key is the channel ID); **Given** the event relay delivers one event twice, **Then** consumers see the same `eventId` both times (the event's identity is derived from the message, not generated per delivery).

### User Story 3 — Come back online and get exactly what was missed (Priority: P1)

A buyer's phone loses signal for an hour. When it reconnects, the app sends the highest sequence it has for each channel and receives every message it missed, once, in order — across any number of channels in one call. Scroll-back for older messages is a separate paged read.

**Why this priority**: the notes' central guarantee: push is best-effort, sync is the guarantee ("no resume protocol" is the named pitfall).

**Independent Test**: insert messages 1–5, sync with cursor 3, expect 4 and 5.

**Acceptance Scenarios**:

1. **AS-21** — **Given** a channel with messages 1–5 and an active member, **When** they `POST /api/chat/sync {cursors: {<channelId>: 3}}`, **Then** `200 [{channelId, messages: [<seq 4>, <seq 5>], lastSeq: 5, hasMore: false}]` with messages in ascending sequence; **When** the cursor is `5` or more, **Then** the channel appears with `messages: []`, `lastSeq: 5`, `hasMore: false`; **When** the cursor is `0`, **Then** messages 1–5.
2. **AS-22** — **Given** a channel with 450 messages, **When** a member syncs with cursor `0`, **Then** the first 200 messages (seq 1–200) with `hasMore: true` and `lastSeq: 450`; **When** they repeat with cursor `200`, then `400`, **Then** seq 201–400 with `hasMore: true`, then seq 401–450 with `hasMore: false`; across the three calls every message is returned exactly once and in order.
3. **AS-23** — **Given** a member of 50 channels, **When** they sync all 50 in one call, **Then** one entry per channel with changes computed per channel; **When** a request names 51 channels, **Then** `400 too_many_channels` and nothing is processed; **When** `cursors` is empty, **Then** `200 []`.
4. **AS-24** — **Given** a cursor map naming a channel the caller is not a member of, a channel they are banned from, and a channel that does not exist, **When** they sync, **Then** the response omits all three, and is byte-identical to a request that never named them; nothing about their existence or content is disclosed.
5. **AS-25** — **Given** the sync route, **When** a key is not a UUID, a cursor is negative, fractional, not a number, or above 9,007,199,254,740,991, or `cursors` is missing or not an object, **Then** `400 validation_failed` and nothing is processed (invalid entries are not silently dropped); **Given** no credentials `401`.
6. **AS-26** — **Given** a deleted message, **When** a member syncs across its sequence, **Then** the entry is `{id, seq, authorId, body: null, replyToId, createdAt, deleted: true}` (a tombstone keeps its sequence, so a client sees no gap); **Given** a member who has just synced a channel's latest messages and a moderator then deletes one of them, **When** the member syncs again from an earlier cursor, **Then** the deleted message is already a tombstone in that very response (a deleted body is never served after the deletion committed).
7. **AS-27** — **Given** a channel with 120 messages, **When** a member calls `GET /api/chat/channels/:channelId/messages?limit=50`, **Then** `200 {items: [seq 120 … seq 71], nextCursor}` newest first, tombstones included; **When** they follow `nextCursor`, **Then** seq 70 … 21, then seq 20 … 1 with `nextCursor: null`; every message appears once; **When** `limit` is `0`, `101` or not an integer, or `cursor` is malformed, **Then** `400 validation_failed`; **When** the caller is a stranger, **Then** `404 channel_not_found` (no message of a channel is readable by a non-member); **When** banned, `403 banned`; **When** `limit` is omitted, **Then** 50.
8. **AS-28** — **Given** the history spans three monthly partitions, **When** a member syncs from cursor `0` and pages history, **Then** messages from all months come back in sequence order with no omission or duplicate at month boundaries; **Given** a message sent at 23:59:59 UTC on the last day of a month, **When** its identical request is replayed at 00:00:01 UTC on the first of the next month, **Then** `200 duplicate: true` with the original `id`, `seq` and `createdAt`, and one row exists; **Given** the first message of a new month, **Then** its sequence continues from the previous month's last (never restarts).
9. **AS-29** — **Given** a frozen clock, **When** the partition maintenance job runs, **Then** monthly history partitions exist for the current month and the next 3 months; **When** it runs again (or two runs overlap), **Then** nothing changes and no error; **Given** a message whose creation time falls in a month with no partition (maintenance has not run), **Then** it is still stored (no insert is ever refused for a missing partition), `chat_history_partition_missing_total` increases by 1, and the next maintenance run reports it.

### User Story 4 — Unread counts and read receipts (Priority: P2)

A buyer sees a badge with the number of messages they have not read in each chat. Opening the chat clears it. The seller sees that the buyer has read their answer.

**Why this priority**: the unread badge and "seen" mark are what make chat feel alive, and they drive the offline push decision.

**Independent Test**: seller posts 5 messages; the buyer's unread is 5; the buyer reads to 3; unread is 2; reads to 999; unread is 0.

**Acceptance Scenarios**:

1. **AS-30** — **Given** a channel with 5 messages by the seller, **When** the buyer calls `GET /api/chat/unread`, **Then** `200 {items: [{channelId, unread: 5, lastSeq: 5}], nextCursor: null}` and for the seller `unread: 0` (their own messages never count); the list is ordered by most recent message first, excludes archived channels and channels the caller is banned from, and has no more than `limit` items (default 50, 1–200, anything else `400 validation_failed`) with `nextCursor` while more remain; each channel appears in exactly one page; `401` without credentials.
2. **AS-31** — **Given** a member whose read position is 2 in a channel at sequence 5 (3 unread), **When** they post a message (sequence 6), **Then** their read position becomes 6 and their unread is 0; **Given** a second member at read position 2, **Then** their unread is 4 (the new message is another's); posting never moves a position backwards; no read receipt is published for this implicit advance.
3. **AS-32** — **Given** a channel at sequence 5 and a member at position 0, **When** they `POST /api/chat/channels/:channelId/read {seq: 3}`, **Then** `200 {lastReadSeq: 3, unread: 2}`; **When** `{seq: 1}` (a stale tab), **Then** `200 {lastReadSeq: 3, unread: 2}` and the stored position is unchanged; **When** `{seq: 999}`, **Then** `200 {lastReadSeq: 5, unread: 0}` (capped at the channel's last sequence).
4. **AS-33** — **Given** the read route, **When** `seq` is missing, negative, fractional, a string, or above 9,007,199,254,740,991, **Then** `400 validation_failed` and nothing changes; **Given** a stranger or a member banned from the channel, **Then** `404 channel_not_found`; **Given** a malformed channel ID `400`; no credentials `401`; **Given** an archived channel, **Then** a member can still mark it read (`200`).
5. **AS-34** — **Given** a member at position 0 in a channel at sequence 5, **When** `{seq: 3}` and `{seq: 5}` are sent simultaneously (repeated 20 times with fresh state), **Then** the final stored position is always 5 and no response reports a position lower than the one stored after the other request committed; **Given** `{seq: 5}` is committed first, **Then** a following `{seq: 3}` publishes nothing.
6. **AS-35** — **Given** a member who advances their position, **When** the read route returns, **Then** a `read` event `{userId, seq}` is published once on the channel's realtime topic after commit and is delivered to active members who are subscribed; **When** the position did not advance (stale or equal), **Then** no event is published; **Given** a subscriber who is not an active member (stranger, banned, or removed), **When** they open the channel's topic, **Then** they are refused and receive nothing; **Given** the realtime hub is unreachable, **Then** the read route still returns `200` with the stored position and `chat_push_failed_total{kind="receipt"}` increases by 1.
7. **AS-36** — **Given** a channel with 51 active members, **When** a member advances their position, or comes online (AS-38), **Then** the position is stored and returned as usual and **no** `read` or `presence` event is published for that channel; **Given** the member count falls to 50, **Then** events resume; nobody gets a notification-per-message either (AS-42).

### User Story 5 — See who is online, without a surveillance feed (Priority: P2)

A buyer sees that the seller is online and expects a quick answer. Online means "sent a heartbeat in the last minute"; it is cheap, ephemeral, and only visible to people who share a chat with that user.

**Why this priority**: presence sets expectations and also decides whether an offline push is needed.

**Independent Test**: heartbeat, query, advance the clock 61 seconds, query again.

**Acceptance Scenarios**:

1. **AS-37** — **Given** two users sharing a channel, **When** user A `POST /api/chat/presence/heartbeat`, **Then** `204`; **When** user B `GET /api/chat/presence?userIds=<A>`, **Then** `200 {"<A>": {online: true, lastSeenAt: <epoch ms of the heartbeat>}}`; **When** the frozen clock advances 59 seconds, **Then** still online; **When** it advances to 61 seconds after the last heartbeat, **Then** `{online: false, lastSeenAt: null}`; a heartbeat in between restarts the 60 seconds.
2. **AS-38** — **Given** user A offline and member of 25 channels (each with ≤ 50 active members), **When** they send their first heartbeat, **Then** a `presence` event `{userId, online: true, ttlSeconds: 60}` is published to exactly their 20 most recently active channels; **When** they send a second heartbeat 30 seconds later, **Then** no event; **When** 20 first heartbeats from the same user arrive simultaneously, **Then** the 20 channels receive exactly one event each in total (one offline → online transition).
3. **AS-39** — **Given** user B and an unrelated user C (no shared active channel) who is online, **When** B queries `userIds=<C>`, **Then** `{online: false, lastSeenAt: null}`, exactly the answer given for an offline user; **When** B queries their own ID and a peer's, **Then** both are answered truthfully; **When** `userIds` has more than 100 entries or one that is not a UUID, **Then** `400 validation_failed`; **When** `userIds` is empty or absent, **Then** `200 {}`; **When** no credentials, **Then** `401`.
4. **AS-40** — **Given** the presence store is down, **When** a heartbeat arrives, **Then** `204` (fail open) and `chat_presence_unavailable_total` increases by 1; **When** presence is queried, **Then** `503 presence_unavailable` (an "all offline" answer would be false); no presence value is ever written to or read from the primary database.
5. **AS-41** — **Given** the per-user heartbeat limit of 6 per minute, **When** a 7th heartbeat arrives within the minute, **Then** `429 rate_limited` with `Retry-After`; the presence state is unchanged by the rejected call.

### User Story 6 — Someone who missed a message hears about it, once (Priority: P2)

A buyer closes the app. The seller answers. Thirty seconds later, if the buyer still has not read it and is not online, they get one push for that chat — not one per message, and nothing if they read it in the meantime.

**Why this priority**: the retention loop of a marketplace chat; it is also where duplicate and false notifications do the most harm.

**Independent Test**: post a message, let 30 seconds pass with the recipient neither reading nor online, and look for exactly one escalation event.

**Acceptance Scenarios**:

1. **AS-42** — **Given** a `chat.message_posted` event for a channel with 3 active members (author included), **When** the scheduler handles it, **Then** exactly 2 delayed checks exist (every active member except the author), each with a 30-second delay and an identity derived from `(eventId, recipientId)`; **Given** a channel with 51 active members, **Then** no check is created; **Given** a banned member, **Then** no check is created for them.
2. **AS-43** — **Given** a due check for `(recipient, channel, messageId, seq)`, **When** it runs, **Then** exactly one outcome: the recipient's read position is ≥ `seq` → `read`, nothing emitted; the recipient is online → `online`, nothing emitted; the message was deleted → `deleted`, nothing emitted; the recipient is no longer an active member, or the channel is archived → `ineligible`, nothing emitted; otherwise → `notified` and exactly one `chat.message_escalated` event is emitted.
3. **AS-44** — **Given** a recipient notified for channel C at 10:00:00, **When** another check for the same `(recipient, C)` runs at 10:04:59, **Then** `coalesced` and nothing is emitted; **When** one runs at 10:05:01, **Then** `notified` and a second event is emitted; **When** a check for a different channel runs at 10:01:00, **Then** `notified` (the window is per recipient and channel); a burst of 20 messages produces one event for the first check and `coalesced` for the rest.
4. **AS-45** — **Given** the presence store is unreachable at check time, **When** a check runs for an unread message, **Then** the recipient is treated as offline and the event is emitted (a duplicate push is better than a missed one) and `chat_presence_unavailable_total` increases; **Given** the coalescing store is unreachable, **Then** the event is still emitted and the downstream `dedupeKey` (`chat:<messageId>:<recipientId>`) prevents a second delivery for the same message.
5. **AS-46** — **Given** the same `chat.message_posted` event delivered twice, **When** both are handled, **Then** the escalation events for each recipient total one (identical check identities collapse); **Given** events for seq 7 then seq 6 (out of order), **Then** both are scheduled and each check decides by its own `seq` (a late-arriving older event cannot cause a wrong decision); **Given** an invalid payload (missing `channelId`, non-integer `seq`, unknown `version`), **Then** it is rejected to the dead-letter queue with no check created and no side effect; the consumer never blocks the queue.
6. **AS-47** — **Given** emitting the escalation fails (outbox refused), **When** the check runs, **Then** the coalescing window is not consumed (a retry can emit), the check is retried with back-off up to 5 attempts and then dead-lettered with `chat_escalation_failed_total` increased; **When** a retry succeeds, **Then** exactly one event exists and the window is consumed.
7. **AS-48** — **Given** a `notified` outcome, **Then** the emitted `chat.message_escalated` v1 event is `{recipientId, channelId, channelTitle, messageId, seq, authorId, preview, dedupeKey: "chat:<messageId>:<recipientId>"}` with `preview` at most 120 characters, **no** author name or e-mail, and `aggregateId = recipientId`; the event is written inside the same transaction as the consumed state change (outbox) and no network call happens inside it.

### User Story 7 — Moderate a product chat (Priority: P3)

The seller and trusted moderators keep the chat civil: ban, mute, promote, delete. Nobody can moderate their equal or their superior, and every illegal move is refused cleanly.

**Why this priority**: required for a public product chat, but rarer than everything above.

**Independent Test**: ban a buyer, show they cannot post; unban them; try to ban the owner.

**Acceptance Scenarios**:

1. **AS-49** — **Given** an active member with role `MEMBER`, **When** shop staff or a channel `MODERATOR` call `POST /api/chat/channels/:channelId/members/ban {userId}`, **Then** `204`, the member's status is `BANNED`, a `ban` event `{channelId, userId}` is published on the moderation bus after commit, and that user can no longer send, join or read history (AS-06, AS-17, AS-27); **When** the same member is banned again, **Then** `409 invalid_transition`; **When** `members/unban` is called on a banned member, **Then** `204`, status `ACTIVE`, an `unban` event is published, their stored read position and role are unchanged; **When** unban targets an active member, **Then** `409 invalid_transition`; no credentials `401`.
2. **AS-50** — **Given** the moderation routes, **When** a `MODERATOR` targets another `MODERATOR` or shop staff, **Then** `403 permission_denied` (strictly higher rank required); **When** anyone targets themselves, **Then** `403 permission_denied`; **When** a plain `MEMBER` calls any moderation route, **Then** `403 permission_denied`; **When** the target is not a member of the channel (never joined, or a made-up user ID), **Then** `404 member_not_found` and no membership is created; **When** the caller is a stranger, **Then** `404 channel_not_found`; **When** `userId` is missing or not a UUID, **Then** `400 validation_failed`; none of these cases changes any row.
3. **AS-51** — **Given** an active member, **When** a moderator calls `POST .../members/mute {userId, minutes: 10}` at the frozen instant T, **Then** `204`, `mutedUntil = T + 10 minutes`, a `mute` event with `mutedUntil` is published; the member can read but `403 muted` on send until `mutedUntil`; **When** muted again with `minutes: 60`, **Then** `204` and `mutedUntil = T' + 60 minutes` (replaced); **When** `minutes` is `0`, `43201`, fractional or missing, **Then** `400 validation_failed`; **When** `members/unmute {userId}` is called on a muted member, **Then** `204`, `mutedUntil` null, an `unmute` event; on a member who is not muted, **Then** `409 invalid_transition`.
4. **AS-52** — **Given** shop staff, **When** they `POST .../members/promote {userId}` for a `MEMBER`, **Then** `204`, role `MODERATOR`, a `promote` event; **When** a `MODERATOR` or `MEMBER` tries it, **Then** `403 permission_denied`; **When** the target is already a `MODERATOR`, **Then** `409 invalid_transition`; **When** staff call `members/demote {userId}` on a `MODERATOR`, **Then** `204`, role `MEMBER`, a `demote` event; on a `MEMBER`, **Then** `409 invalid_transition`.
5. **AS-53** — **Given** a message by member A, **When** A calls `DELETE /api/chat/channels/:channelId/messages/:messageId`, **Then** `204`, the message is a tombstone (`deleted: true`, body never served again, deleter and time recorded), a `message_deleted {channelId, messageId}` event is published on the live bus after commit, and its sequence is retained; **When** a moderator deletes a `MEMBER`'s message, **Then** `204`; **When** a moderator deletes a message by a moderator or by shop staff, **Then** `403 permission_denied`; **When** a non-author `MEMBER` tries, **Then** `403 permission_denied`; **When** the same delete is repeated, or two deletes arrive at once, **Then** `204` each, exactly one tombstone and one event; **When** the message does not exist or belongs to another channel, **Then** `404 message_not_found`; **When** a stranger, **Then** `404 channel_not_found`.
6. **AS-54** — **Given** the staff member who created a channel (stored role `OWNER`), **When** that person is removed from the shop (their `products.write` membership no longer exists), **Then** their next `PATCH`, `promote`, `demote`, ban of a moderator, or archive is `403 permission_denied` (manager authority is the live shop membership, not a stored role); they keep being an ordinary member of the channel; **When** another staff member of the shop is added, **Then** they can manage the channel at once without joining it first.
7. **AS-55** — **Given** a signed-in user, **When** they `POST /api/chat/ws-ticket`, **Then** `201 {ticket, wsUrl, expiresAt}` where the ticket is a signed credential for the realtime gateway whose subject is the user, whose purpose claim is `ws`, and which expires 60 seconds after issue (`expiresAt` equals that instant at the frozen clock); **When** no credentials, **Then** `401`; **When** 31 are requested within one minute by one user, **Then** the 31st is `429 rate_limited`; a ticket is never accepted as an API access credential (the purpose claim differs) and no ticket is issued to a user whose session is revoked.

### User Story 8 — The chat respects its neighbours and its own life cycle (Priority: P3)

Chat holds no one else's data and nobody holds chat's. When a shop is deleted, its chats go with it.

**Why this priority**: constitution IX and the domain map make this binding; it is also what makes `chat` extractable.

**Independent Test**: publish `tenancy.shop_deleted` for a shop with chats; the chats are gone; then run the static ownership gate.

**Acceptance Scenarios**:

1. **AS-56** — **Given** a shop with 2 channels (and members, messages), **When** `tenancy.shop_deleted {shopId}` is processed, **Then** both channels, their members and their messages are removed in bounded batches, and no cached messages of those channels remain readable; **When** the same event is delivered again (or a second consumer instance runs at once), **Then** no error and no further change; **When** it names a shop with no channels, **Then** nothing happens and a counter `chat_purge_noop_total` increases; **When** the payload is invalid (missing or non-UUID `shopId`), **Then** it is dead-lettered with no deletion; other shops' channels are never touched.
2. **AS-57** — **Given** channels created before shops existed (no shop recorded), **When** the shop backfill runs in batches of at most 200 channels, **Then** each channel gets its product's `shopId` (looked up through the catalog service, with the shop provisioned through the tenancy provisioning service where the seller has none), the batch is repeatable (a second run changes nothing), a channel whose product is gone is marked for review and skipped without stopping the batch, and after the backfill the channel's shop is required (a new channel without one is refused by the store).
3. **AS-58** — **Given** the finished capability, **Then** the static gates report zero findings for `chat`: `pnpm --dir packages/backend check:table-ownership --strict` (no model or SQL access to a table another domain owns; no foreign key or association from chat tables to another domain's), `check:boundaries`, `check:module-graph`, `check:model-registry`; the domain's public entry point exports modules, DTO types and event contracts but no model and no infrastructure class; **Given** the realtime gateway's existing statements (create a membership, insert a message without a sequence or client ID, update the last-read time), **Then** each still succeeds against the final schema and the inserted message receives its sequence and its event (AS-14, AS-20).

### Edge Cases

- A deletion that happens after a client already holds the message is not re-delivered by sync (a cursor only moves forward); the live `message_deleted` push and the next history read carry it (see Assumptions).
- A client whose cursor is **ahead** of the channel's last sequence (restored backup, wrong environment) receives `messages: []` and the real `lastSeq`; it is the client's cue to reset its cursor.
- A member is banned while their offline check is pending: the check ends `ineligible` (AS-43).
- A muted member still reads, syncs, marks read and appears present.
- A channel archived while a push check is pending: `ineligible`.
- The product behind a channel is archived or deleted after creation: the channel stays as it is; archiving it is the shop's decision (see Assumptions).
- Two clients of one user (phone and laptop) share one read position and one presence; the larger position and the latest heartbeat win.
- A message and a read update racing in the same channel never produce an unread below zero or above the channel's last sequence.
- The creator's stored role is `OWNER` but shop staff (live) hold the authority; a channel never becomes "ownerless" because a person left.
- Sequence values stay below 2^53 so every client can hold them as an ordinary number; the validation upper bound is 9,007,199,254,740,991.

## Requirements *(mandatory)*

### Functional Requirements

**Channels and membership**

- **FR-001**: A channel is created only by a member of the product's owning shop who holds the `products.write` permission, for an `ACTIVE` product, at most one channel per product (concurrent creations yield one), recording the product's shop (AS-01…AS-04). The caller becomes the stored `OWNER` member.
- **FR-002**: Joining is open to any signed-in user, idempotent, refused for a banned member and for an archived channel, and starts the joiner's read position at the channel's current sequence (AS-05, AS-06).
- **FR-003**: Reading a channel's metadata by ID, its messages, its sync entries, its read state and its realtime topic requires an `ACTIVE` membership; everyone else gets `404` with no disclosure (AS-07, AS-24, AS-27, AS-33, AS-35). Only the discovery route `by-product` is readable by any signed-in user, and it returns public fields only.
- **FR-004**: A channel can be renamed and archived or unarchived by a manager (FR-031); archived channels take no new members and no new messages, remain readable, and repeating a state is `409 invalid_transition` (AS-08).

**Messages, idempotency, sequence (P0607)**

- **FR-010**: A message has a body of 1–4,000 Unicode code points (trimmed, never whitespace-only), an optional reply reference to a message of the same channel (existing or tombstoned), and a client-generated UUID (AS-09, AS-15, AS-16).
- **FR-011**: A send is idempotent per `(channel, author, clientMessageId)`: an identical replay returns the original with `duplicate: true`, a replay with different content is `422 idempotency_key_reuse`, another author's identical ID creates a separate message, and simultaneous identical sends create exactly one message (AS-10…AS-13).
- **FR-012**: Every stored message receives a per-channel sequence number that starts at 1, increases by exactly 1, never repeats and never leaves a gap, whichever writer inserted it (this API or the realtime gateway), including under concurrency and when a write is rejected; it is assigned by the system of record, never by a client or a clock (AS-09, AS-14, AS-15, AS-58).
- **FR-013**: Sends are refused for strangers (`404`), banned members (`403 banned`), muted members (`403 muted` with `mutedUntil`) and archived channels (`409 channel_archived`), and are rate-limited per user (AS-17, AS-18).
- **FR-014**: A message is published on the live bus after it is stored; a failure to publish never fails or undoes the send, and is counted (AS-19).
- **FR-015**: Every stored message yields exactly one `chat.message_posted` event, keyed by channel with `version = seq`, whichever writer inserted it; its identity is derived from the message so relays can repeat it harmlessly (AS-20).

**Sync and history**

- **FR-020**: Sync takes up to 50 channel cursors, returns per channel the messages with `seq` greater than the cursor in ascending order (at most 200 per channel, `hasMore` when truncated) and the channel's `lastSeq`; it is read-only (AS-21…AS-23).
- **FR-021**: Channels the caller may not read are omitted without any trace; malformed input is refused rather than silently dropped (AS-24, AS-25).
- **FR-022**: Deleted messages are returned as tombstones that keep their sequence, and a deleted body is never served after the deletion committed, even from a warm cache (AS-26).
- **FR-023**: History is read newest-first in keyset pages with an opaque cursor, a deterministic order ending in the sequence, `limit` 1–100 (default 50), tombstones included, and requires an active membership (AS-27).
- **FR-024**: The message history is stored in monthly partitions by creation time; sync, history and uniqueness (FR-011, FR-012) behave identically across partition boundaries; partitions for the current and next 3 months always exist, created by a scheduled single-run idempotent job; a message is never refused for want of a partition (AS-28, AS-29, P0318).

**Unread and receipts**

- **FR-030**: Unread for a member and channel is `lastSeq − lastReadSeq` and is never negative; a member's own messages never count (posting advances their position); archived channels and channels the member is banned from are not listed; the list is keyset-paged (AS-30, AS-31).
- **FR-031**: *Manager authority* over a channel belongs to a member of the channel's shop with `products.write`, checked live against the shop's membership at the time of the action; a stored `MODERATOR` may moderate lower ranks (FR-040); the stored `OWNER` role confers no authority by itself (AS-54).
- **FR-032**: Marking read is monotonic (never moves back) and capped at the channel's last sequence, safe under concurrency, and answers `{lastReadSeq, unread}`; invalid input is `400` (AS-32…AS-34).
- **FR-033**: An advance of the read position, and only an advance, publishes a `read {userId, seq}` event on the channel's realtime topic after commit, visible to active members only; a publish failure never fails the request (AS-35).
- **FR-034**: In channels with more than 50 active members no read or presence events are published (AS-36).

**Presence**

- **FR-035**: A heartbeat marks the user online for 60 seconds, held only in an ephemeral store; the offline → online transition (and only it) publishes one `presence` event to the user's 20 most recently active channels; simultaneous first heartbeats yield one transition (AS-37, AS-38).
- **FR-036**: A presence query (≤ 100 IDs) answers truthfully only for users sharing an active channel with the caller (the caller included); everyone else is reported offline; malformed input is `400` (AS-39).
- **FR-037**: When the ephemeral store is down, heartbeats are accepted and counted, queries answer `503 presence_unavailable`, and the offline push treats unknown presence as offline (AS-40, AS-45). Heartbeats are rate-limited (AS-41).

**Offline push**

- **FR-038**: Each posted message schedules a check 30 seconds later for every active member except the author, only in channels of at most 50 active members; checks are idempotent by `(eventId, recipientId)` (AS-42, AS-46).
- **FR-039**: A check decides by the table of AS-43 (`read`, `online`, `deleted`, `ineligible`, `notified`), coalesces to one escalation per recipient and channel per 5 minutes (AS-44), fails toward notifying when its auxiliary stores are down (AS-45), releases the window when emitting fails and retries up to 5 times (AS-47), and emits `chat.message_escalated` carrying no author name (AS-48). The consumer is idempotent, validates its payload, and dead-letters poison messages (AS-46).

**Moderation, ticket, lifecycle**

- **FR-040**: Moderation (ban, unban, mute, unmute, promote, demote, delete message) follows the rank rule *strictly higher rank required* (shop staff > `MODERATOR` > `MEMBER`; nobody acts on themselves), applies only to existing members, publishes its event on the moderation bus after commit, answers `204`, and refuses an illegal transition with `409 invalid_transition` (AS-49…AS-53). Delete is idempotent.
- **FR-041**: Only manager authority promotes and demotes; mute duration is 1–43,200 minutes (AS-51, AS-52).
- **FR-042**: A signed-in user can obtain a short-lived (60 s) gateway ticket; it is rate-limited and not usable as an API credential (AS-55).
- **FR-043**: `tenancy.shop_deleted` purges the shop's channels, members and messages in bounded batches, idempotently, with a validated payload (AS-56).
- **FR-044**: Channels created before shops existed receive their shop through a repeatable batched backfill (AS-57).
- **FR-045**: Chat owns its tables exclusively and reaches other domains only through the mechanisms in Cross-capability contracts; its public entry point exports no model (AS-58).

**Cross-cutting**

- **FR-050**: Every response parses against its schema in `packages/contracts`; every error is problem+json with `code` and `requestId`; 5xx details are generic.
- **FR-051**: Every record lookup carries the principal in its predicate (membership), never "load then check" (III.4); all lists use keyset pagination (III.10); time is read only through the injected clock.
- **FR-052**: Observability: counters `chat_push_failed_total{kind}`, `chat_limiter_unavailable_total`, `chat_presence_unavailable_total`, `chat_escalation_failed_total`, `chat_history_partition_missing_total`, `chat_purge_noop_total`, and the outcome of each offline check `chat_offline_check_total{outcome}`; the log lines never contain message bodies, only IDs and lengths.

**Defaults** (configuration with validated bounds): body max 4,000 code points; sync ≤ 50 channels, ≤ 200 messages per channel; history `limit` ≤ 100; unread `limit` ≤ 200; presence TTL 60 s, ≤ 100 IDs, broadcast to 20 channels; "small channel" threshold 50 active members; offline grace 30 s, coalescing window 300 s, preview 120 characters; mute 1–43,200 minutes; ws ticket 60 s; send limit 10 per 10 s per user, sync 30 per minute per user, read 60 per minute per user, heartbeat 6 per minute per user, presence query 30 per minute per user, channel create 10 per hour per user, ticket 30 per minute per user.

### Key Entities

- **Channel**: one per product; `id`, `productId`, `shopId` (plain IDs, copies under IX.8), `sellerId` (creator), `title`, archived state with time, `lastSeq` (the channel's sequence counter), `lastMessageAt`.
- **Member**: `(channel, user)`, `role` (`OWNER`, `MODERATOR`, `MEMBER`), `status` (`ACTIVE`, `BANNED`), `mutedUntil`, `lastReadSeq`, `lastReadAt`.
- **Message**: `id` (time-ordered), `channelId`, `seq`, `authorId`, `body`, `replyToId`, `clientMessageId`, `createdAt`, deletion marker (`deletedAt`, `deletedBy`); monthly partitioned by creation time.
- **Presence**: an ephemeral per-user marker with a 60-second life; never in the primary database.
- **Check (offline escalation)**: a delayed, idempotent decision for `(message, recipient)`; not stored in the primary database.
- **Events**: `chat.message_posted`, `chat.message_escalated`; realtime events `read`, `presence`; live-bus events `message`, `message_deleted`, `channel_archived`; moderation events `ban`, `unban`, `mute`, `unmute`, `promote`, `demote`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With 20 senders posting to one channel at the same moment, every message gets a distinct number and the numbers form an unbroken sequence 1…N, in 100% of 1,000 repeated runs (AS-14).
- **SC-002**: A client offline for any length of time that reconnects recovers 100% of the messages it missed, once each and in order, in as many calls as ⌈missed ÷ 200⌉ per channel (AS-21, AS-22).
- **SC-003**: Replaying one send 1,000 times, one after another or all at once, never creates a second message (AS-10, AS-13).
- **SC-004**: During a reconnect storm of 50,000 catch-up requests per second, 99% answer within 100 milliseconds (load test, an ops artifact).
- **SC-005**: A message posted while its recipient is offline and has not read it produces at most one push per channel per 5 minutes, the first no later than 60 seconds after the message; a recipient who reads within 30 seconds receives none (AS-43, AS-44).
- **SC-006**: A user who stops sending heartbeats shows as offline to others within 60 seconds, and a user who comes online is announced exactly once per transition (AS-37, AS-38).
- **SC-007**: Zero messages, read positions or presence values of a chat are visible to a user who is not an active member (and presence only to those sharing a chat), across every cross-tenant scenario (AS-07, AS-24, AS-27, AS-33, AS-35, AS-39).
- **SC-008**: While the live push channel, the presence store or the rate limiter is down, sending and catching up keep working at normal success rates (AS-18, AS-19, AS-35, AS-40).
- **SC-009**: The platform accepts 25,000 messages per second across all channels without losing or reordering any (capacity target, ops artifact).
- **SC-010**: The unread badge a user sees equals `latest − last read` for every channel, with 0 occurrences of a negative badge or a badge counting the user's own messages (AS-30…AS-32).

## Cross-capability contracts

Specs searched: `S01`, `S03`, `S05`, `S23` (the only written specs naming chat or S24 under `specs/domains`; `specs/web` and `specs/journeys` do not exist yet). Honoured:

- **S01**: `Firewall`, `@User()` / `AuthenticatedUser = { id, role, sessionId, amr }` (honoured). **Differs**: S01 lists S24 as a consumer of `UserDirectoryService.getUsersByIds` for "user display"; S24 needs no user lookup (no display name is published, moderation targets must already be members, so no user-existence check) and does **not** consume it (`questions.md`, CONTRACT).
- **S03**: S24 consumes `ShopAccessService.assertMember` (R1) and `tenancy.shop_deleted` and runs its own shop-id backfill through `ShopProvisioningService.ensureShopsForLegacySellers` (≤ 200, idempotent), dropping its foreign keys to `Shop` and `User`; S03 stops reading `ChatChannel` (S03 AS-62). All honoured.
- **S05**: `ProductQueryService.getProductsByIds(ids, { shopId? })` (R1) with `ProductDto.{id, shopId, title, status: 'ACTIVE' | 'ARCHIVED'}` (honoured; replaces `ProductDtoService` and the `ChatChannel → Product` association).
- **S23**: no contract (live-stream comments are a separate, lossy feature).
- **W05 (not written)**: consumes the HTTP contract below and the realtime topic; **J-series journeys** consume the events.

**Provides** (exact names; HTTP under `/api`; problem+json errors with `code`; schemas in `packages/contracts`: `chatChannelSchema`, `chatMessageSchema`, `sendMessageRequestSchema` = `{clientMessageId, body, replyToId?}`, `sendMessageResponseSchema` = `{message, duplicate}`, `chatMessagePageSchema` = `{items, nextCursor}`, `chatSyncRequestSchema` = `{cursors}`, `chatChannelSyncSchema` = `{channelId, messages, lastSeq, hasMore}`, `chatUnreadPageSchema` = `{items: {channelId, unread, lastSeq}[], nextCursor}`, `markReadRequestSchema` = `{seq}`, `markReadResponseSchema` = `{lastReadSeq, unread}`, `presenceResponseSchema` = `Record<UserId, {online, lastSeenAt: number | null}>`, `chatWsTicketSchema` = `{ticket, wsUrl, expiresAt}`):

- HTTP (all `Firewall()`, session required):
  - `POST /chat/channels {productId, title?}` → `201 chatChannelSchema` = `{id, productId, shopId, sellerId, title, isArchived, archivedAt, createdAt, updatedAt, myRole: 'OWNER' | 'MODERATOR' | 'MEMBER' | null}`.
  - `POST /chat/channels/:channelId/join` → `200 chatChannelSchema`.
  - `GET /chat/channels/by-product/:productId` → `200 chatChannelSchema` (`myRole: null` for non-members); `GET /chat/channels/:channelId` → `200 chatChannelSchema` (members only); `PATCH /chat/channels/:channelId {title?, isArchived?}` → `200 chatChannelSchema`.
  - `POST /chat/channels/:channelId/messages` → `201 | 200 sendMessageResponseSchema`; `chatMessageSchema` = `{id, seq: number, authorId, body: string | null, replyToId: string | null, createdAt: ISO-8601, deleted: boolean}`.
  - `GET /chat/channels/:channelId/messages?limit&cursor` → `200 chatMessagePageSchema` (newest first); `DELETE /chat/channels/:channelId/messages/:messageId` → `204`.
  - `POST /chat/sync {cursors: Record<ChannelId, number>}` → `200 chatChannelSyncSchema[]` (read-only despite `POST`).
  - `GET /chat/unread?limit&cursor` → `200 chatUnreadPageSchema`; `POST /chat/channels/:channelId/read {seq}` → `200 markReadResponseSchema`.
  - `POST /chat/presence/heartbeat` → `204`; `GET /chat/presence?userIds=<csv ≤ 100>` → `200 presenceResponseSchema` (`503 presence_unavailable` when the store is down).
  - `POST /chat/channels/:channelId/members/{ban|unban|promote|demote} {userId}` and `.../members/mute {userId, minutes}` and `.../members/unmute {userId}` → `204`.
  - `POST /chat/ws-ticket` → `201 chatWsTicketSchema`.
- Realtime topic registered by `ChatTopicsModule` in S51's hub: `chat:<channelId>` (prefix `chat`; members-only policy; no replay) with events `read` `{userId, seq}` and `presence` `{userId, online: true, ttlSeconds: 60}`.
- Gateway buses (compatible with the Rust gateway's formats; keys `chat:channel:<channelId>` and `chat:moderation`): channel events `message` `{channelId, message: {id, channelId, authorId, body, replyToId, createdAt}}` (plus `seq` when the writer is this API), `message_deleted` `{channelId, messageId}`, `channel_archived` `{channelId}`; moderation events `ban|unban|mute|unmute|promote|demote` `{channelId, userId, mutedUntil?}`.
- Events (topic `chat.events`; envelope `{eventId, type, version, occurredAt, aggregateId}`):
  - `chat.message_posted` v1 payload `{channelId, messageId, seq, authorId, preview}`; `aggregateId = channelId` (Kafka key), envelope `version = seq`; at-least-once, `eventId` deterministic per message. **Consumers: this capability's offline scheduler; S28 and analytics may subscribe.**
  - `chat.message_escalated` v1 payload `{recipientId, channelId, channelTitle, messageId, seq, authorId, preview, dedupeKey}`; `aggregateId = recipientId`; **Consumer: S28 (`notifications`) — creates the push/inbox item of type `chat.message` (in category `chat`) honouring the recipient's preferences and quiet hours; it must deduplicate on `dedupeKey`.**
- Rate-limit policies (declared in S50's registry): `chat.send.user` 10 per 10 s, `chat.sync.user` 30 per minute, `chat.read.user` 60 per minute, `chat.heartbeat.user` 6 per minute, `chat.presence.user` 30 per minute, `chat.channel-create.user` 10 per hour, `chat.ws-ticket.user` 30 per minute; all fail open.
- Job (registered with S49): `chat.partition-maintenance` (daily, concurrency 1, no payload).
- Modules for the apps (exported from `@app/domains/chat`): `ChatModule` (core: channels, moderation, ticket), `ChatSyncModule` (core: send, sync, history, unread, read, presence), `ChatTopicsModule` (sse-gateway: topic registration), `ChatOfflineWorkerModule` (worker: offline check consumer, partition-maintenance job), `ChatProjectorModule` (projector: offline scheduler, shop-deleted purge consumer). Nothing else is exported: no model, repository, service class or key helper.
- **Gateway compatibility** (the Rust gateway is out of scope, D1, and writes the same tables): the three statements it runs today (create-if-absent membership with role `MEMBER`/status `ACTIVE`; insert a message with `id, channelId, authorId, body, replyToId, createdAt`; update `lastReadAt`) remain valid; the system of record supplies the sequence and the event for gateway-written messages.

**Requires** (owning capability, exact shape assumed):

- **S01** (`identity`): `Firewall()`, `@User()` → `AuthenticatedUser`; session revocation visible to the ticket route.
- **S03** (`tenancy`): `ShopAccessService.assertMember(shopId: ShopId, userId: UserId, permission?: ShopPermission): Promise<{ role: ShopRole }>` (R1; throws not-found or forbidden) with `products.write` held by OWNER, ADMIN and STAFF; `ShopProvisioningService.ensureShopsForLegacySellers(sellerIds: UserId[]): Promise<Map<UserId, ShopId>>` (R1, ≤ 200, idempotent); event `tenancy.shop_deleted` v1 `{shopId}` on its topic keyed by `shopId`.
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[], options?: { shopId?: ShopId }): Promise<Map<ProductId, ProductDto>>` (R1, one call per channel creation, `ProductDto.{id, shopId, title, status}`).
- **S28** (`notifications`): consumes `chat.message_escalated` (see Provides); chat does not call S28 directly.
- **S49** (jobs): recurring registration with single-run semantics. **S50** (rate limits): the seven policies by name with `Retry-After`.
- **S51** (realtime hub): `TopicRegistry.define({ prefix, policy })`, `RealtimePublisher.publish(topic, event, payload, { replay?: boolean })`.
- **S52** (cache toolkit): cache-aside with single flight for the recent-messages window; no cache is ever a source of truth.
- **S53** (events): change-data-capture or outbox emission of `chat.message_posted` for rows written by any writer (decision in `questions.md`); `outbox.append(event)` for `chat.message_escalated` inside the domain's own transaction (IX.6); delayed single-consumer tasks `TaskQueue.enqueueBatch(queue, [{ body, options: { delaySeconds, dedupeId? } }])` and `consume(queue, handler, { concurrency })`; consumer framework with inbox, payload validation, retries, DLQ.
- **S54** (platform toolkit): problem+json filter with `code`/`requestId`, config validation, metrics registry, request context and clock, graceful shutdown.

Cross-domain data used by S24 (constitution IX.7): **R1** — tenancy's `ShopAccessService.assertMember` and `ShopProvisioningService`; catalog's `ProductQueryService.getProductsByIds`; **R2** — none inside the domain (a product page that shows "chat with the seller" composes `GET /api/chat/channels/by-product/:productId` in the BFF over HTTP, S48); **R3** — none (the escalation and shop-purge are event reactions, IV.3; the `productId`, `shopId` and `title` on a channel are copies taken at creation under IX.8 and are not refreshed). The ephemeral presence and scheduler state are not tables, so IX does not apply to them.

## Assumptions

- **Decision policy**: where today's behaviour and the notes or constitution differ, the production-grade option wins and is tagged `[BREAKING]` in `questions.md` (e.g. non-members can no longer read history; idempotency conflicts are `422`; unread no longer counts one's own messages; list responses are pages).
- **Channel creation by shop staff** replaces "the product's seller user": product ownership is the shop's (S05, S03). The channel's `sellerId` stays as the creating user for display and gateway compatibility; authority comes from the live shop membership (FR-031).
- **Channels are open to join** for any signed-in user (a public product chat), as today; per-channel member caps and invitation-only chats are not offered. Channels above 50 active members are "forum-like" (no per-message push, receipts or presence broadcasts) — the notes' "huge channels: lightweight unread notifications instead of pushing every message".
- **Sequence mechanism is a plan decision.** The spec fixes the guarantee (gap-free, per channel, for every writer, no sequence consumed by a rejected write). The per-channel serialization of writers is accepted: different channels never contend, one hot channel is bounded by its single sequence counter (the notes' documented next step for 25k msg/s is moving history to a wide-column store; not built here).
- **Event emission for gateway-written rows**: the default is change-data-capture of the message table (IV.4 allows outbox or CDC); the existing database trigger that inserts into the outbox table is a cross-owner write that IX.4/IX.6 do not allow, and stays only as a recorded, dated exception if CDC is not yet available (`questions.md`).
- **Partitioning versus uniqueness** (P0318): a partitioned table cannot enforce unique `(channelId, seq)` or `(channelId, authorId, clientMessageId)` across months by itself; the plan must still honour AS-28 (for example with a small chat-owned dedupe store). Retention beyond "keep all history" is an operations matter (partitions can be detached); no deletion policy is specified.
- **Sync does not re-deliver deletions** of messages a client already has (cursor semantics); the live push and the next history read do. A "changes since" feed is not offered.
- **Gateway pushes** may not carry `seq` (the Rust writer's statement does not return it); clients treat a push as a hint, reconcile by message `id`, and learn sequences from sync or HTTP responses. Gateway behaviour is out of scope.
- **Presence** is a 60-second lease; there is no explicit "offline" event on expiry (clients age a presence event by its `ttlSeconds`), no "last seen" beyond the live lease, and no per-user opt-out.
- **Read receipts** are per member and per channel (a position), shown to active members of small channels; there is no per-message "delivered" mark (a client's successful sync is its delivery acknowledgement).
- **Moderation targets must already be members**; pre-emptive bans of non-members are not offered (this avoids a user-existence lookup and creating rows for made-up IDs). `DELETE` of a message is idempotent (a second delete is `204`), unlike state toggles which answer `409`.
- **Escalation content** is channel title plus preview; the author is not named because the identity domain has no public display name and an e-mail-derived label would leak personal data. A later display-name capability would be composed by S28, not stored here.
- **Product archived or deleted after channel creation** does not change the channel; a catalog-driven auto-archive is not offered. Shop export on `tenancy.shop_offboarding_started` is not offered for chat data (messages are other people's content); purge on `tenancy.shop_deleted` is.
- **Message edit, attachments, typing indicators, and 1:1 chats** are out of scope; the stored `editedAt` column is unused and may be dropped by the plan.
- **Time** is read only through the injected clock; the frozen clock drives mute expiry, presence and coalescing in tests.
