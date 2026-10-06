# Feature Specification: S23 — Live Launch Stream (comments, reactions, sampling, batching, moderation, pinned commerce) — domain `launch-events`

**Feature Branch**: `S23-live-stream` (spec directory `specs/domains/S23-live-stream`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Capability S23 — Live launch stream comments and reactions: sampling, batching, moderation, pinned commerce (domain `launch-events`)." Sources: `docs/showcase/sections/SD-15-live-launch-stream.md`; note `10-System-Design/06-realtime-and-collaboration.md` §15 (live comments / reactions); constitution v3.1.0; `docs/architecture/domain-map.md` (`launch-events`); `docs/architecture/pattern-map.md` row P1106 (reservoir sampling, the only row naming S23); the current code of `packages/backend/libs/domains/launch-events/` (live part only: `live*.module.ts`, `api/live.controller.ts`, `application/live.service.ts`, `domain/reservoir.ts`, `domain/moderation.ts`, `infra/live-*.ts`) and the delivery tier in `packages/backend/apps/sse-gateway/src/live/`. The booking part of the domain is S22.

## Scope

In scope:

- **Streams**: a shop's staff creates a live launch stream (optionally tied to a launch event by its plain ID), starts it, ends it. A stream moves `SCHEDULED → LIVE → ENDED` and never back.
- **Comment ingest**: any signed-in viewer posts a short plain-text comment to a `LIVE` stream. A cheap synchronous check (links, banned terms including disguised spellings, per-user rate limit, mute list) runs before anything is published. Accepted comments are delivered live and persisted for history without slowing the poster.
- **Sampling and batching**: nobody can read thousands of comments a second, so each viewer receives a bounded, fair sample (at most 5 sampled comments per 250 ms window, i.e. 20 per second) delivered as one batch per window. Shop staff comments and the viewer's own comments are never sampled away.
- **Reaction aggregation**: reactions (❤️ 🔥 😂 😮 👏 🛒) are counted, not forwarded: viewers receive per-second totals, never individual reactions.
- **Late joiners**: a viewer who opens the stream sees the last 50 comments, the current pin and the stream status immediately, then live updates, with no gap between the two.
- **Moderation**: synchronous checks (above) plus asynchronous scoring that retracts toxic comments after the fact; staff can remove any comment, mute a viewer in the stream and unmute.
- **Pinned commerce**: staff pin one product of their own shop with a short message and an optional "left" counter ("Buy now — 500 left"); it reaches every viewer through the same channel; unpinning and replacing are live too.
- **History**: every accepted comment is stored time-bucketed for 30 days, with removals marked; ended and running streams can be replayed minute by minute.
- **Operations**: per-instance viewer cap, slow-viewer shedding, the per-second statistics publisher (reaction totals and viewer count), behaviour when a store is down, and observability.

Out of scope (owners named):

- Booking, waiting room, seat holds and the seat map of a launch event → **S22** (`launch-events`, same domain, separate capability). S23 reads nothing of S22 and S22 exports nothing to S23.
- Video itself (ingest, transcoding, delivery) → **S30** (`media`). This capability carries chat, reactions and the pin, not pictures.
- The realtime hub (topic registry, replay, per-topic policy, connection fan-out engine) → **S51**. Rate-limit engine → **S50**. Job scheduler → **S49**. Outbox and projection framework → **S53**. Problem+json filter, config validation, metrics, health, graceful shutdown → **S54**. Cache toolkit → **S52**.
- Shop membership, roles and permissions → **S03** (`tenancy`). Product data → **S05** (`catalog`). Authentication → **S01** (`identity`). This capability uses them only through the mechanisms named under Cross-capability contracts.
- Buying the pinned product (cart, checkout, flash-sale admission) → **S10**, **S11**. The pin carries a product ID and a message; it never decides a purchase.
- Notifying followers that a stream went live → **S28** may consume `live.stream_started`; no notification is produced here.
- Friends and follow graphs: no social graph exists in this platform; "friends' comments" of the notes is not offered (see Assumptions). Per-shop banned-word lists and a human-moderation queue UI are not offered.
- A web UI: no web capability in `scripts/sdd/capabilities.tsv` covers live-stream pages (see `test-plan.md`).

## Clarifications

Decided unattended; each is also in [`questions.md`](questions.md), BREAKING and CONTRACT first.

- Staff routes move under the shop (`/shops/:shopId/live/:streamId/...`) so the shop-scoped guard decides access; a user who is not a member of the owning shop gets `404`, a member without the permission gets `403`.
- "Staff" for priority delivery means a member of the owning shop whose role grants `products.write` (OWNER, ADMIN, STAFF). A read-only member is an ordinary viewer.
- A comment's visible author name is a stable pseudonymous handle per (user, stream); the e-mail local part is never shown (today it is).
- Reactions with an out-of-range count are refused (`422`), not silently clamped.
- Comment posts accept an optional client-generated `clientId` so a retried request never duplicates a comment.
- Chat is lossy by design: no replay of comments after a reconnect; a reconnect gets a fresh snapshot (notes, SD-15).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A viewer follows a huge stream without drowning (Priority: P1)

Two million people watch a product reveal. Comments arrive at thousands per second and reactions at hundreds of thousands. Each viewer sees a calm, readable chat of at most 20 comments a second, the shop's own messages always, their own comments always, a live reaction tally, and the "Buy now" pin the moment it appears. Someone joining late sees what just happened first.

**Why this priority**: without sampling and batching the delivery tier collapses (5,000 comments × 2,000,000 viewers per second) and nobody can read the chat anyway.

**Independent Test**: start a stream, open several viewer connections, post a burst of 600 comments in one second plus three staff comments, and check batch counts, sizes, content, ordering, the snapshot of a late joiner, and control events.

**Acceptance Scenarios**:

1. **AS-01 (fair sample)** — **Given** one 250 ms window in which 1,250 ordinary comments were posted, **When** the window closes, **Then** each viewer receives exactly 5 of them (a uniform random sample: every comment, early or late in the window, equally likely) and the batch states the observed rate `rate = 5000` (comments in the window × 4); **Given** a window with 3 ordinary comments, **Then** all 3 are delivered and `rate = 12`; the sampler holds at most 5 items regardless of the window's volume.
2. **AS-02 (cap and batching)** — **Given** a viewer on a `LIVE` stream and 600 comments from 100 users posted within one second, **When** the viewer collects what arrives during the next 2 seconds, **Then** it receives at most one `comments` event per 250 ms window (at most 5 events inside any one second), every event holds at most 5 sampled comments (so at most 20 sampled comments per second sustained), and no `comment` is ever sent as a separate single event.
3. **AS-03 (never sampled away)** — **Given** the burst of AS-02 plus 3 staff comments (priority) posted in the same window and viewer `V`'s own comment in that window, **Then** every viewer's batch for that window contains all 3 staff comments, and `V`'s batch contains `V`'s own comment (flagged `mine: true`) even when it was not in the random sample; **Given** 30 staff comments in one window, **Then** all 30 are delivered in that window's batch (none dropped, none deferred); other viewers never see `mine: true`.
4. **AS-04 (batch content rules)** — **Given** a window with priority, own and sampled comments, **Then** the batch lists each comment once (a comment that is both priority and sampled appears once), ascending by comment ID (which is time-ordered); **Given** a window in which nothing was posted, **Then** no event is sent; **Given** no events for 15 s, **Then** the connection receives a keep-alive comment line.
5. **AS-05 (one upstream per instance)** — **Given** 1,000 viewers connected to the same gateway instance for one stream, **Then** the instance holds exactly one subscription to that stream's comment feed and one to its control topic and runs one sampler; **When** the last local viewer disconnects, **Then** both subscriptions and the sampler are released and the instance's viewer entry is removed within 1 second; a new first viewer starts them again.
6. **AS-06 (late joiner snapshot)** — **Given** 120 comments posted, one of them removed, a pin set and the stream `LIVE`, **When** a viewer opens the event connection, **Then** the first event is `snapshot` `{status: 'LIVE', pin, recent}` where `recent` is the last 50 non-removed comments ascending by ID, and the next events are live batches; a viewer connecting to a stream with no comments gets `recent: []` and `pin: null`.
7. **AS-07 (no gap between snapshot and live)** — **Given** a viewer connecting while staff change the pin and remove comments, **When** the connection is established (20 repetitions with the changes fired concurrently), **Then** applying `snapshot` followed by every later control event, with the ordering rules of AS-09, always yields the server's final pin and the final set of visible comments: no event published between reading the snapshot and starting delivery is lost.
8. **AS-08 (control events are immediate)** — **Given** connected viewers, **When** staff pin a product, remove a comment, or start/end the stream, or the per-second statistics are published, **Then** every viewer receives `pin`, `comment_removed`, `status` or `stats` within 250 ms of the publication, unsampled and not held for the next window.
9. **AS-09 (duplicate and out-of-order control events)** — **Given** the client reducer of the shared contracts package, **When** it receives a `pin` whose `version` is not higher than the current one, a `stats` whose `second` is not higher than the last, a `comment_removed` for an unknown comment, or a `comments` batch containing a comment already removed, **Then** the first two are ignored, the third is remembered so that a later arrival of that comment is not displayed, and the fourth item is dropped; applying the same events twice or in a different order yields the same final state (property tested).
10. **AS-10 (slow viewer shedding)** — **Given** a viewer whose connection buffers more than 256 KB, **When** the next batch is written, **Then** that connection is closed, `live_viewers_dropped_total{reason="slow"}` increases by 1, other viewers are unaffected, and reconnecting delivers a fresh snapshot with no replay of missed comments.
11. **AS-11 (instance viewer cap)** — **Given** an instance at its configured maximum of concurrent viewers, **When** another viewer connects, **Then** `503` problem+json `code: gateway_full` with `Retry-After: 5`, no subscription is created, and existing viewers are unaffected.
12. **AS-12 (stream states on the event connection)** — **Given** an unknown stream ID, **Then** `404 stream_not_found`; a malformed ID `400`; an `ENDED` stream `409 stream_ended`; **Given** a `SCHEDULED` stream, **Then** the connection opens with `snapshot {status: 'SCHEDULED'}` and later receives `status {status: 'LIVE'}` when staff start the stream; **Given** a connected viewer when the stream ends, **Then** the viewer receives `status {status: 'ENDED'}` and the connection is closed within 1 second, and the instance releases the stream (AS-05).
13. **AS-13 (private comment feed)** — **Given** the realtime hub, **When** any client (anonymous or signed in) subscribes to the comment feed topic of a stream or to any topic prefix this capability does not register, **Then** the subscription is refused exactly as for an unknown topic; **When** a client subscribes to the public control topic `stream:<id>`, **Then** it receives only `status`, `pin`, `comment_removed` and `stats` events and never a comment.
14. **AS-14 (viewer count)** — **Given** two instances with 100 and 50 connections (anonymous and signed-in alike) for one stream, **When** the per-second statistics are published, **Then** `viewers = 150`; **When** one instance crashes (stops reporting), **Then** its entry is ignored after 15 seconds and `viewers = 50`.

### User Story 2 — A viewer posts a comment; abuse is stopped before it spreads (Priority: P1)

A signed-in viewer types a comment. If it is clean and the viewer is not flooding, it appears for others within a second and is saved. Links, scam terms (also disguised), floods and muted users are stopped at the door, cheaply, so the stream stays usable.

**Why this priority**: the write path and its guardrails keep the stream trustworthy and keep a spammer from costing the platform anything.

**Independent Test**: post accepted, blocked, flooded, muted and retried comments as several users and check the response, what was published and what was stored.

**Acceptance Scenarios**:

1. **AS-15 (accepted comment)** — **Given** a `LIVE` stream and a signed-in viewer, **When** they `POST /api/live/:streamId/comments {text: "Take my money!"}`, **Then** `201 liveCommentSchema` `{id, streamId, authorId, authorName, text, at, priority?}` with `id` a time-ordered UUID and `at` the server time in epoch milliseconds; the comment is on the recent list (position newest), delivered to the stream's viewers within one window, and exactly one `live.comment_posted` event is on the event stream; no relational query is made.
2. **AS-16 (staff priority)** — **Given** a member of the owning shop with role OWNER, ADMIN or STAFF, **When** they post, **Then** the comment carries `priority: true` and is delivered per AS-03; **Given** a member with a read-only role (VIEWER), a member of another shop, or a non-member, **Then** no `priority`.
3. **AS-17 (input validation)** — **Given** bodies: `text` missing, not a string, empty or blank after trimming, longer than 200 Unicode code points after normalization (NFC, control and zero-width characters removed, runs of whitespace collapsed), an unknown extra property, a `clientId` that is not a UUID, **Then** `422` problem+json with `errors[]` naming the field, and nothing is published or stored; exactly 200 code points (including emoji sequences counted as their code points) is accepted and stored in normalized form; a malformed `streamId` is `400`.
4. **AS-18 (authentication and state)** — **Given** no credentials, **Then** `401`; **Given** an unknown stream, **Then** `404 stream_not_found`; **Given** a `SCHEDULED` or `ENDED` stream, **Then** `409 stream_not_live`; in none of these is anything published, stored or counted against the stream.
5. **AS-19 (synchronous moderation)** — **Given** `LIVE` stream and texts: `"visit http://x.io"`, `"www.x.io"` (links), `"scam"`, `"SCAMS!!"`, `"sc4m"`, `"s c a m"`, `"scaaaam"`, `"scám"`, `"free iphone"`, `"click here"` (banned terms in plain, leet, letter-spaced, stretched and accented spellings), **Then** each is `422 comment_blocked` with `reason: "link"` for links and `reason: "policy"` for the rest (the banned list is never revealed in the response), nothing is published or stored, and the attempt still consumes the user's rate-limit budget; **Given** `"fa keyboard"`, `"scampi pasta"`, `"I love it"`, **Then** each is accepted (terms match whole words after normalization; `"scams"` and `"scam"` match, `"scampi"` does not).
6. **AS-20 (per-user rate limit)** — **Given** the policy of 3 comments per 10 seconds per user, **When** one user sends a 4th comment within the window, **Then** `429` problem+json with `Retry-After` and nothing published; another user is unaffected; **Given** the limiter's store down, **Then** comments are still accepted (fail open: chat stays up and async moderation covers abuse) and `live_limiter_unavailable_total` increases.
7. **AS-21 (mute)** — **Given** a viewer muted in stream `S`, **When** they post to `S`, **Then** `403 user_muted`, nothing published; the same viewer posts normally to stream `T`; **Given** the fast store wiped after the mute, **Then** the viewer is still muted (the mute is durable) on their next post; **Given** staff unmute, **Then** the viewer can post again; **Given** the muted viewer's earlier comments, **Then** they stay until removed individually.
8. **AS-22 (retry safety)** — **Given** a post with `clientId = C` that succeeded, **When** the same user retries with the same `C` and the same text, **Then** `200` with the original comment (same `id`, same `at`), no second delivery, no second event, one entry on the recent list; **Given** the same `C` with different text, **Then** `422 client_id_reused`; **Given** another user using `C`, **Then** it is independent; **Given** 20 simultaneous posts with the same `C`, **Then** exactly one `201`, nineteen `200` with the same `id`, one event.
9. **AS-23 (failure ordering)** — **Given** the event stream refusing writes, **When** a comment is posted, **Then** `503 live_unavailable` (generic detail), the comment is neither delivered nor on the recent list, and a retry with the same `clientId` once the stream recovers yields exactly one visible comment and one history item; **Given** the recent list / feed refusing writes after the event was accepted, **Then** `503 live_unavailable`, and a retry with the same `clientId` yields exactly one visible comment and exactly one history item (the history entry is keyed by the comment ID).
10. **AS-24 (the hot path never waits on the relational database)** — **Given** a warm `LIVE` stream, **When** 1,000 comments are posted (30 concurrent), **Then** zero relational queries are made on the comment path (stream state, shop ID and the poster's staff role come from the fast store or the identity/tenancy exports' own caches); **Given** the stream's cached state evicted, **When** 100 concurrent comments arrive, **Then** exactly one relational read refills it; **Given** 1,000 posts to 1,000 distinct unknown stream IDs, **Then** each answers `404` and at most one relational read per distinct ID is made, with the "unknown" answer cached for 10 seconds.
11. **AS-25 (no personal data in a comment)** — **Given** any comment visible through delivery, snapshot, history or an event, **Then** `authorName` is the stable handle derived from (user, stream) — the same user keeps the same handle in one stream and has a different, non-reversible handle in another — and the user's e-mail, name parts of it, and session data appear in no payload.

### User Story 3 — Reactions are counted, not streamed (Priority: P1)

Viewers hammer ❤️ and 🔥. The stream shows live totals once a second; the platform never sends an individual reaction to anyone.

**Why this priority**: 200,000 reactions a second cannot be fanned out; counting them is the only design that scales.

**Independent Test**: send reactions from many users concurrently, wait for the per-second statistics, and compare the totals with what was sent.

**Acceptance Scenarios**:

1. **AS-26 (accepted reaction batch)** — **Given** a `LIVE` stream and a signed-in viewer, **When** they `POST /api/live/:streamId/reactions {reactions: {"❤️": 7, "🔥": 2}}`, **Then** `202` with no body, the counts are added to the current second's totals, and nothing is written to the relational database or the history store and no event is published.
2. **AS-27 (totals are exact and broadcast once a second)** — **Given** 100 concurrent requests each sending `{"❤️": 7}` in one second, **When** that second has finished, **Then** the next `stats` event for the stream has `second` = that second and `reactions["❤️"] = 700` (no lost or doubled increments); **Then** viewers receive only `stats` totals for reactions, never a per-reaction event; emoji with zero counts are omitted; a second with no reactions still produces a `stats` with `reactions: {}` and the viewer count.
3. **AS-28 (reaction validation)** — **Given** bodies with an emoji outside {❤️ 🔥 😂 😮 👏 🛒}, a count of 0, negative, greater than 20, non-integer or non-numeric, an empty `reactions` object, more than 6 keys, or an extra property, **Then** `422` with `errors[]`, and nothing at all is counted (all-or-nothing: a valid emoji in the same body is not counted either); `{"❤️": 20}` is accepted and counts 20.
4. **AS-29 (authentication and state)** — **Given** no credentials, **Then** `401`; unknown stream `404 stream_not_found`; `SCHEDULED` or `ENDED` stream `409 stream_not_live`; nothing counted.
5. **AS-30 (reaction rate limit)** — **Given** the policy of 5 requests per second per user, **When** a 6th arrives in the same second, **Then** `429` with `Retry-After`; **Given** the limiter's store down, **Then** reactions are accepted (fail open).
6. **AS-31 (one statistics publisher per stream)** — **Given** two worker instances running the statistics publisher for 30 seconds over 3 live streams, **Then** each stream gets at most one `stats` per second from the fleet (every `second` appears once); **When** the instance publishing for a stream stops, **Then** the other takes over within 4 seconds; streams that are not `LIVE` get no `stats`, and a stream that ends stops getting them within 2 seconds; a reaction counted late for a second that was already broadcast is ignored and never added to a later second.
7. **AS-32 (reaction totals for analytics)** — **Given** a second with non-empty totals, **When** the publisher aggregates it, **Then** exactly one `live.reactions_aggregated` `{streamId, second, reactions}` is on the event stream for that (stream, second) even if the aggregation runs twice; seconds with no reactions produce none.

### User Story 4 — Shop staff run the stream: lifecycle, pinned commerce, moderation (Priority: P2)

The brand's team creates the stream, goes live, pins "Buy now — 500 left", answers questions (their comments always show), deletes a nasty comment and mutes a troll — in seconds, from the shop's own tools.

**Why this priority**: staff controls make the stream a sales surface and keep it safe; they are low-volume and rely on the viewer path above.

**Independent Test**: as staff of shop A drive the full lifecycle, pin/unpin/replace, remove and mute, and verify what viewers receive and what a member of shop B or a read-only member can do.

**Acceptance Scenarios**:

1. **AS-33 (create)** — **Given** a member with `products.write`, **When** `POST /api/shops/:shopId/live {title, launchEventId?}`, **Then** `201 liveStreamSchema` `{id, shopId, title, status: 'SCHEDULED', launchEventId, startedAt: null, endedAt: null, createdAt}`; `title` outside 3–120 characters or `launchEventId` not a UUID → `422`; a non-member of the shop → `404`; a member without `products.write` → `403`; no credentials → `401`; the response never contains another shop's data.
2. **AS-34 (lifecycle and illegal transitions)** — **Given** a `SCHEDULED` stream, **When** staff `POST …/start`, **Then** `200` status `LIVE`, `startedAt` set, `status` event `LIVE` to viewers, and `live.stream_started` is on the outbox exactly once in the same transaction as the status change; **When** start is repeated or sent 20 times concurrently, **Then** the transition and the event happen once and every response is `200` with the current stream; **When** `POST …/end` on a `LIVE` stream, **Then** `200` status `ENDED`, `endedAt` set, the pin cleared, `status` event `ENDED`, and one `live.stream_ended` `{streamId, shopId, endedAt, durationSeconds}`; end repeated → `200`, no second event; **When** start is sent for an `ENDED` stream, **Then** `409 stream_ended`; **Given** a `SCHEDULED` stream, **When** staff end it, **Then** `200` `ENDED` (cancelled before start: `startedAt` stays null, `durationSeconds: 0`); **Given** the outbox refusing the event, **Then** the status is unchanged and the caller gets `503`.
3. **AS-35 (cross-tenant access)** — **Given** staff of shop A and a stream of shop B, **When** they call any staff route of this capability with shop A's ID and B's stream ID, or with B's shop ID, **Then** `404 stream_not_found` (or `404` from the shop guard) and no state of B's stream changes; the response for a stream of another shop is indistinguishable from an unknown stream.
4. **AS-36 (pin)** — **Given** a `LIVE` stream and a product of the same shop, **When** staff `PUT …/pin {productId, text: "Buy now — 500 left", stockLeft: 500}`, **Then** `200 pinSchema` `{version, productId, productTitle, text, stockLeft, pinnedAt}`, a `pin` event with the same payload reaches every viewer (AS-08), later snapshots contain it, and it survives a wipe of the fast store; each change increments `version` by 1 starting from 1; **When** the identical body is sent again, **Then** `200` with the same `version` and no new event; **When** replaced with a different message or `stockLeft`, **Then** `version + 1` and a new event.
5. **AS-37 (pin validation and guard)** — **Given** a `productId` that is unknown, belongs to another shop, or is archived, **Then** `422 product_not_pinnable` (the three cases are indistinguishable); `text` empty or longer than 80 characters, `stockLeft` negative, non-integer or above 1,000,000 → `422`; `productId` malformed → `400`; a `SCHEDULED` or `ENDED` stream → `409 stream_not_live`; the pin's price, name and stock are never decided by the pin (it carries `productTitle` as of `pinnedAt` and the staff-supplied `stockLeft` only).
6. **AS-38 (unpin and concurrent pins)** — **Given** a pin, **When** staff `DELETE …/pin`, **Then** `204`, a `pin` event with payload `null` and `version + 1`, snapshots show `pin: null`; unpinning when nothing is pinned → `204`, no event; **Given** two staff members pinning different products at the same instant (20 repetitions), **Then** the versions are distinct and consecutive, the stored pin is the one with the higher version, and a viewer applying events in any order ends on that pin (AS-09).
7. **AS-39 (remove a comment)** — **Given** a comment on the recent list, **When** staff `DELETE …/comments/:commentId`, **Then** `204`; the comment leaves the recent list and later snapshots; a `comment_removed {id}` event reaches every viewer; exactly one `live.comment_removed` `{streamId, commentId, at, reason: 'moderator', actorId}` is on the event stream; a repeat or 20 concurrent removals → `204` each, still one event; **Given** a comment aged out of the recent list but still in history, **Then** removal works the same; **Given** an unknown comment, a comment of another stream, or one past history retention, **Then** `404 comment_not_found`; a malformed ID `400`; **Given** the event stream refusing writes, **Then** `503`, the comment stays visible, and a retry once recovered completes with one event.
8. **AS-40 (mute and unmute)** — **Given** staff of the owning shop, **When** `POST …/mutes/:userId`, **Then** `204` and the user is muted in this stream (AS-21); repeating → `204` (idempotent); `DELETE …/mutes/:userId` → `204` and the user can post (an unmute of a user who is not muted is `204`); **Given** the target is a member with `products.write` of the owning shop, **Then** `422 cannot_mute_staff`; **Given** a user ID unknown to identity, **Then** `204` (IDs are plain references; muting is harmless); a muted user can still watch and react.
9. **AS-41 (staff-only routes)** — **Given** an anonymous caller, a signed-in viewer, a read-only member, **When** they call pin, unpin, remove, mute or unmute, **Then** `401`, `404` (non-member) and `403` (read-only member) respectively, and nothing changes.
10. **AS-42 (public snapshot)** — **Given** any stream, **When** an anonymous caller `GET /api/live/:streamId`, **Then** `200 liveSnapshotSchema` `{id, shopId, title, status, launchEventId, startedAt, endedAt, pin, recent}` with `Cache-Control: public, s-maxage=1`; unknown → `404`; malformed → `400`; 1,000 concurrent anonymous reads cause at most one relational read per second for that stream.

### User Story 5 — Nothing is lost and bad comments are retracted afterwards (Priority: P2)

Every accepted comment ends up in the history; the heavier toxicity check runs after the fact and takes bad comments down within about a second; a removal is never lost even if it overtakes the comment it targets.

**Why this priority**: history gives replay and an audit trail, and async moderation lets the hot path stay cheap while the stream stays clean.

**Independent Test**: publish comments and removals to the event stream in odd orders and twice, with a throttled history store, and check the history and what viewers received.

**Acceptance Scenarios**:

1. **AS-43 (history persistence)** — **Given** 1,000 `live.comment_posted` events spread over 3 minutes, **When** the history writer consumes them, **Then** all 1,000 are stored under their minute bucket (`STREAM#<streamId>#<yyyyMMddHHmm>`, sorted by comment ID) with a 30-day expiry, written in groups of at most 25; **Given** the store throttling part of each group, **Then** the leftovers are retried with growing waits until stored; **Given** the leftovers still failing after the retry limit, **Then** the delivery fails and is redelivered (never dropped).
2. **AS-44 (duplicates and out-of-order)** — **Given** the same `live.comment_posted` delivered twice, **Then** one history item; **Given** a `live.comment_removed` processed before its `live.comment_posted`, **Then** after both the item holds the text and `removed: true` with the reason; **Given** the removal processed twice, **Then** the item is unchanged; a removal for a comment that never arrives leaves only a marker that expires with the history.
3. **AS-45 (invalid input to consumers)** — **Given** a message with an invalid payload (missing field, wrong type, unknown major version) in a batch with valid messages, **Then** it is rejected to the dead-letter path without any write, and the valid messages in the same batch are processed.
4. **AS-46 (history read)** — **Given** a stream with comments over several minutes, one removed, **When** `GET /api/live/:streamId/history?minute=202610051530&limit=100&cursor=`, **Then** `200 liveHistoryPageSchema` `{items, nextCursor}` of that minute's non-removed comments ascending by ID, `limit` 1–200 (default 100), the cursor continues without duplicates or gaps; a `minute` outside the stream's running period or in the future → `200` with empty `items`; a malformed `minute` or `limit` → `422`; an unknown stream → `404`; a `SCHEDULED` stream → empty; removed comments never appear; anonymous access is allowed.
5. **AS-47 (asynchronous moderation)** — **Given** an accepted comment the classifier scores at 0.7 or higher, **When** the moderation consumer processes it, **Then** within 1 second at p95 the comment leaves the recent list, viewers receive `comment_removed`, and `live.comment_removed {reason: 'auto', score}` is emitted once; a score below 0.7 changes nothing; **Given** the same comment event delivered twice, **Then** one removal; **Given** the classifier slow or failing (timeout 2 s), **Then** the comment stays visible, the delivery is retried 3 times with backoff and then dead-lettered with `live_moderation_failed_total`, and the history writer's progress is unaffected (independent consumer).
6. **AS-48 (removal ordering with delivery)** — **Given** a comment already delivered to viewers and then removed (by staff or auto), **When** the `comment_removed` event reaches a viewer, **Then** the viewer's reducer drops it (AS-09); a viewer who connects after the removal never receives it in the snapshot or in history reads.

### User Story 6 — The stream survives faults and can be operated (Priority: P3)

Stores fail, instances crash, and people deploy during a launch. The stream degrades predictably, comes back by itself, and an operator can see what is happening without reading comments.

**Why this priority**: a launch is a one-shot event; faults must not end it, and a showcase must show how to run it.

**Independent Test**: wipe or stop each store in turn during a running stream, run the reconciler, and read metrics and logs from a full run.

**Acceptance Scenarios**:

1. **AS-49 (fast store wiped)** — **Given** a `LIVE` stream with a pin, mutes and comments and the fast store wiped, **Then** the next comment is accepted (stream state reloaded from the authoritative record), the pin and the mutes are intact (durable records), the recent list is empty and refills, and within 30 seconds the set of active streams for the statistics publisher is rebuilt without operator action.
2. **AS-50 (reconciler)** — **Given** the active-stream set missing a `LIVE` stream and containing an `ENDED` one, **When** the reconcile job runs (twice at once), **Then** the set equals the authoritative `LIVE` streams, the mute cache is rebuilt for them, and the result is the same for both runs.
3. **AS-51 (store outages)** — **Given** the event stream down, **Then** comment posts are `503 live_unavailable` (AS-23) while reactions still `202`, existing viewers keep receiving control events, and the pin/lifecycle routes work; **Given** the fast store down, **Then** comment and reaction posts are `503 live_unavailable`, new event connections `503`, `GET /api/live/:streamId` answers `200` from the authoritative record with `recent: []` and `degraded: true`, and staff lifecycle routes still work; recovery needs no restart.
4. **AS-52 (observability)** — **Given** a full flow (post, block, flood, react, pin, remove, mute, end), **Then** metrics exist for: comments by result and block reason, items per batch, comments per window, delivery lag (accepted → written to a viewer), concurrent viewers, viewers dropped by reason, reactions counted, `stats` published, removals by source, history lag, consumer failures; every log line carries `streamId` and the request ID; no comment text, e-mail, token or `clientId` appears in any log line, metric label or error body.
5. **AS-53 (configuration)** — **Given** configuration with a window ≤ 0, a sample size outside 1–50, a viewer cap ≤ 0 or a moderation threshold outside (0, 1], **Then** the process refuses to start naming the setting; valid defaults: window 250 ms, sample 5, cap 50,000, threshold 0.7.
6. **AS-54 (domain isolation)** — **Given** the repository after this capability, **Then** `pnpm --dir packages/backend check:table-ownership --strict` reports no line for `launch-events` (no tenancy model injected, no foreign table in any query); the staff checks use tenancy's exported service and the pin check uses catalog's exported service; the domain's public entry exports only Nest modules and DTO/contract types; the gateway logic is hosted in the domain, not in `apps/`; the tables this capability owns (`LiveStream`, `LiveMute`) are in the ownership registry.

### Edge Cases

Each is an acceptance scenario above:

- Concurrency: 20 concurrent `start` (AS-34), concurrent comments with one `clientId` (AS-22), concurrent removals (AS-39), concurrent pins (AS-38), 100 concurrent reaction requests summed exactly (AS-27), two statistics publishers (AS-31), concurrent cache refill (AS-24).
- Idempotent replay: comment `clientId` (AS-22), repeated start/end/unpin/mute/unmute/removal (AS-34, AS-38, AS-39, AS-40), identical pin (AS-36), duplicate history and moderation deliveries (AS-44, AS-47).
- Illegal state transitions: start after end (AS-34), pin/comment/react on a stream that is not `LIVE` (AS-18, AS-29, AS-37), event connection to an ended stream (AS-12).
- Cross-tenant and authorization: staff routes with another shop's stream (AS-35), role matrix (AS-33, AS-41), pinning another shop's product (AS-37), private comment feed (AS-13), staff cannot be muted (AS-40).
- Limits: 200-code-point comments, 20 per emoji, 6 emoji, 5 sampled per window, 256 KB buffer, viewer cap, history `limit` ≤ 200, pin text 80 (AS-17, AS-28, AS-02, AS-10, AS-11, AS-46, AS-37); rate limits (AS-20, AS-30).
- Timeouts and faults: classifier timeout (AS-47), store outages and wipes (AS-49, AS-51), a viewer instance crashing (AS-14), publisher takeover (AS-31), outbox refusal (AS-34).
- Out-of-order or duplicate events: removal before post (AS-44), stale `pin`/`stats`, removed comment arriving late in a batch (AS-09), late reaction for a closed second (AS-31).
- Reconnect: no replay, fresh snapshot (AS-10, AS-06); snapshot/live race (AS-07).

## Requirements *(mandatory)*

### Functional Requirements

**Streams and lifecycle**

- **FR-001**: A stream is `SCHEDULED`, `LIVE` or `ENDED`; the only transitions are `SCHEDULED → LIVE`, `LIVE → ENDED`, `SCHEDULED → ENDED`; each is one conditional update of the authoritative record; repeating a completed transition is a successful no-op without a second event; any other transition is `409 stream_ended` (AS-34).
- **FR-002**: `live.stream_started` and `live.stream_ended` MUST be recorded on the outbox in the same transaction as the status change, exactly once per transition; a refused outbox append leaves the status unchanged (AS-34).
- **FR-003**: Creating, starting and ending a stream, and every staff action, require membership of the owning shop with `products.write`, decided by tenancy's shop-scoped access check; a non-member and a stream of another shop are indistinguishable from "unknown" (`404`), a member without the permission gets `403` (AS-33, AS-35, AS-41).
- **FR-004**: A stream may reference a launch event by its plain ID; this capability neither validates it nor reads launch-event data (S22 owns that); the reference is informational (AS-33).
- **FR-005**: Ending a stream clears its pin, rejects further comments, reactions and pins, stops the statistics for it and closes viewer connections (AS-12, AS-34).

**Delivery, sampling, batching**

- **FR-006**: Viewers receive stream data through one event connection `GET /api/live/:streamId/events` (server-sent events). Anonymous viewers may watch; only signed-in users may post or react (AS-12).
- **FR-007**: Each gateway instance MUST hold one upstream subscription per stream for comments and one for control events, however many viewers it serves, and release them when the last local viewer leaves (AS-05).
- **FR-008**: Comment delivery is windowed: every 250 ms the instance closes a window and sends each viewer at most one `comments` event `{items, rate}`; no window with nothing to send produces an event (AS-02, AS-04).
- **FR-009**: Per window and per viewer, ordinary comments are reduced by uniform reservoir sampling to at most 5 (20 per second), and `rate` reports the window's total comment count × 4 (AS-01, AS-02).
- **FR-010**: Priority comments (shop staff, FR-011) and the viewer's own comments MUST be included in the window in addition to the sample, never dropped, deferred or capped, and each comment appears once, ascending by ID (AS-03, AS-04).
- **FR-011**: A comment is priority when its author is a member of the owning shop with `products.write`; the flag is set at post time from tenancy's exported role lookup (AS-16).
- **FR-012**: Control events (`pin`, `comment_removed`, `status`, `stats`) bypass sampling and batching and reach connected viewers within 250 ms (AS-08).
- **FR-013**: Opening an event connection MUST establish delivery first and read the snapshot second, then send `snapshot` followed by buffered and live events, so that nothing published in between is lost; clients order and de-duplicate by `pin.version`, `stats.second` and comment ID (AS-07, AS-09).
- **FR-014**: The snapshot holds `{status, pin, recent}` with `recent` = the last 50 non-removed comments ascending by ID (AS-06). There is no replay of missed comments on reconnect; a reconnect gets a fresh snapshot (AS-10).
- **FR-015**: A connection that buffers more than 256 KB is closed (AS-10); an instance at its viewer cap answers `503 gateway_full` with `Retry-After: 5` (AS-11); keep-alive lines go out every 15 s (AS-04).
- **FR-016**: The comment feed (every accepted comment) is private to the delivery tier: no client may subscribe to it; the public control topic never carries a comment (AS-13).
- **FR-017**: Each connection receives `status` when the stream starts or ends; on end the connection is closed within 1 second (AS-12).

**Comments and moderation**

- **FR-018**: A comment is plain text of 1–200 Unicode code points after normalization (NFC, control and zero-width characters removed, whitespace collapsed, trimmed); other bodies and extra properties are `422` (AS-17).
- **FR-019**: Order of checks on `POST /api/live/:streamId/comments`: authentication (`401`) → per-user rate limit (`429`) → body validation (`422`) → stream exists (`404`) → stream `LIVE` (`409`) → mute (`403 user_muted`) → synchronous moderation (`422 comment_blocked`) (AS-17–AS-21).
- **FR-020**: Synchronous moderation rejects links (`http(s)://`, `www.`) and banned terms after normalization (case, accents, leet substitutions, repeated letters, letter-spacing, punctuation), matching whole words only; the response reveals the reason class (`link` or `policy`), never the list; blocked attempts count against the rate limit (AS-19).
- **FR-021**: The comment rate limit is 3 per 10 seconds per user and fails open (AS-20).
- **FR-022**: An accepted comment gets a time-ordered unique ID and is made durable on the event stream before it becomes visible live; a failed durable write answers `503 live_unavailable` with nothing visible (AS-23).
- **FR-023**: A request may carry `clientId` (UUID, per user, valid for 10 minutes); repeating it with the same text returns the original comment (`200`), with different text `422 client_id_reused`; a comment is never delivered or stored twice because of a retry (AS-22, AS-23).
- **FR-024**: Mutes are durable per (stream, user), enforced on the comment path from a fast cache that is rebuilt from the durable record on a miss; muting is idempotent; staff members cannot be muted; muted users still watch and react (AS-21, AS-40).
- **FR-025**: The author name shown is a stable handle derived from (user, stream), non-reversible; no e-mail or name part appears in any payload (AS-25).
- **FR-026**: The comment path makes no relational query when the stream's state is warm; unknown stream IDs are negatively cached for 10 seconds; a cold state is refilled by one shared read (AS-24).
- **FR-027**: Removing a comment (by staff or by async moderation) is one operation: make the removal durable on the event stream first, then drop the comment from the recent list and publish `comment_removed`; it is idempotent with at most one `live.comment_removed` per comment within 24 hours; failure leaves the comment visible and retryable; a comment must exist in the recent list or history, otherwise `404 comment_not_found` (AS-39).
- **FR-028**: Asynchronous moderation scores every accepted comment through a classifier port independently of history writing; a score of 0.7 or more removes the comment (reason `auto`, with the score); a failing classifier leaves comments visible, retries 3 times with backoff and dead-letters (AS-47).

**Reactions and statistics**

- **FR-029**: A reaction request carries 1–6 distinct allowed emoji, each with an integer count 1–20; anything else is rejected whole with `422` (AS-28). Accepted requests answer `202` and add to the current second's counters spread over several shards; they never touch the relational or history stores and never publish an event (AS-26).
- **FR-030**: Once per second per `LIVE` stream, exactly one publisher in the fleet sums the finished second's counters across shards and the fresh viewer counts and publishes `stats {second, reactions, viewers}`; takeover after a publisher stops happens within 4 seconds; late increments for a closed second are discarded (AS-27, AS-31).
- **FR-031**: Viewer counts are reported per gateway instance every 5 seconds; entries older than 15 seconds are ignored (AS-14).
- **FR-032**: Non-empty per-second totals are also emitted once as `live.reactions_aggregated` (AS-32).
- **FR-033**: Reaction rate limit: 5 requests per second per user, fail open (AS-30).

**Pinned commerce**

- **FR-034**: Staff pin one product of the owning shop with a message (1–80 characters) and an optional `stockLeft` (integer 0–1,000,000); the product is checked through catalog's exported lookup with the shop filter; unknown, foreign and archived products are refused alike (`422 product_not_pinnable`) (AS-36, AS-37).
- **FR-035**: The pin is durable on the stream's authoritative record, has a `version` increasing by 1 per change, is broadcast as a `pin` event with that version, and is part of every snapshot; identical re-pins and unpinning an empty pin broadcast nothing (AS-36, AS-38).
- **FR-036**: A pin never decides a purchase: it carries `productTitle` as of `pinnedAt` and the staff-supplied `stockLeft` only, no price (AS-37).

**History**

- **FR-037**: Every accepted comment is stored in the history under (stream, minute bucket) sorted by comment ID with a 30-day expiry; writes are batched (≤ 25), unprocessed leftovers retried with growing waits, and redelivery is safe (same key) (AS-43).
- **FR-038**: Posts and removals may arrive in any order and any number of times: the stored item always ends with the text and the removed marker; processing is idempotent (AS-44).
- **FR-039**: Consumers reject invalid payloads without side effects and keep processing the rest of the batch (AS-45).
- **FR-040**: `GET /api/live/:streamId/history` returns one minute's non-removed comments paged by cursor (AS-46).

**Operations**

- **FR-041**: The fast store holds only derived or short-lived data (recent list, counters, caches, active set); the stream status, pin and mutes live in durable records, and the active set and mute cache are rebuilt by a single-run job every 30 seconds (AS-49, AS-50).
- **FR-042**: When a store fails the capability degrades as stated in AS-51 and recovers without restart.
- **FR-043**: Observability as in AS-52; no personal or comment content in logs, metrics or errors.
- **FR-044**: Configuration is validated at start (AS-53).
- **FR-045**: Every error is problem+json with a stable `code` and `requestId`; `5xx` details are generic (V.3).
- **FR-046**: The public entry of the domain exports only Nest modules and contract types; other domains' data enters only through R1 exports named below (AS-54).
- **FR-047**: Rate limits for anonymous reads: snapshot 120 per minute per address, event connections 30 opens per minute per address, both fail open (AS-42, AS-12).

### Key Entities

- **Live stream**: a shop's broadcast session: id, shop ID, title, status, optional launch-event ID, start and end times, current pin and its version. Authoritative, durable.
- **Comment**: id (time-ordered), stream, author ID, author handle, text, time, optional priority flag. Lives on the recent list (last 50) and in history (30 days).
- **Reaction totals**: per stream, per second, per emoji counts; short-lived.
- **Pin**: product ID, product title as of pin time, message, optional `stockLeft`, version, pinned time; at most one per stream.
- **Mute**: (stream, user) with who muted and when; durable.
- **Viewer connection**: one event connection of one viewer on one gateway instance; carries the sampler's view of a window.
- **Window**: a 250 ms delivery interval of one stream on one instance.
- **Stats**: the per-second `{second, reactions, viewers}` broadcast.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A viewer never receives more than 5 sampled comments per 250 ms window nor more than one comment batch per window, even when 5,000 comments per second are posted.
- **SC-002**: Shop staff comments and a viewer's own comments reach the viewer in the same window in 100% of windows.
- **SC-003**: A posted comment reaches 99% of connected viewers' batches within 1 second of acceptance on a stream with 5,000 comments per second.
- **SC-004**: A viewer joining mid-stream sees the last 50 comments and the pin on their first event, and never misses a pin change or removal made while connecting.
- **SC-005**: Reaction totals shown equal the reactions accepted (±0 lost or doubled increments in a controlled test of 10,000 reactions) and arrive once per second.
- **SC-006**: No individual reaction is ever delivered to a viewer.
- **SC-007**: A comment that violates the synchronous rules (links, banned terms in every disguise listed) never reaches a viewer; a toxic comment caught asynchronously is gone from every viewer within 2 seconds at p95.
- **SC-008**: A retried comment never appears twice for any viewer and never twice in history.
- **SC-009**: 99% of accepted comments are readable in history within 5 seconds.
- **SC-010**: After the fast store is wiped mid-stream, comments are accepted again on the next request and the stream's statistics resume within 30 seconds, with the pin and mutes intact.
- **SC-011**: A member of one shop can read or change nothing of another shop's stream (0 successful cross-tenant requests in the cross-tenant suite).
- **SC-012**: The comment path makes zero relational queries on a warm stream under a 1,000-comment test.
- **SC-013**: No e-mail address, comment text, token or `clientId` appears in any log line, metric label or error body of a full flow run; no comment payload carries the author's e-mail.
- **SC-014**: One gateway instance carries 50,000 concurrent viewers per stream with one upstream subscription (capacity proof by the k6 SSE run, an ops artifact outside the e2e table).

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains` for `S23` and `launch-events`; `specs/web` and `specs/journeys` do not exist yet). Contracts they require from this capability and how they are honoured:

- **S22 (same domain)**: S22 exports nothing to S23 and S23 must not import S22 internals; the shared `LaunchEventTopicsModule` registers only `queue` and `event` for S22 (honoured: this capability registers its own `stream` prefix in its own `LiveTopicsModule`; the `stream` line in today's shared topics file is removed — see `questions.md` [CONTRACT]). The launch-event reference of a stream is a plain ID, unvalidated (honoured: FR-004).
- **S03**: `ShopAccessService` (R1) replaces `ShopMembership` reads in launch-events/S23 (honoured: FR-003, FR-011; gaps G-01, G-02). `ShopScoped(permission)` with the shop-status gate and `404` for non-members (honoured: FR-003).
- **S01**: `Firewall`, `@User()` (honoured). S01 has no public display name, hence the derived handle (FR-025).
- **S05**: `ProductQueryService.getProductsByIds(ids, { shopId })` is the product check (honoured: FR-034).
- **S11 / S21 / S10**: no contract on S23.
- **J03 (journey, not written)**: consumes `live.stream_started`, the stream routes, the event connection, `stats` and the pin.

**Provides** (exact names; HTTP under `/api`; problem+json errors with `code`; schemas in `packages/contracts`; modules exported from `@app/domains/launch-events`):

- HTTP (schemas: `liveStreamSchema`, `createLiveStreamRequestSchema`, `liveCommentSchema`, `postCommentRequestSchema` = `{text, clientId?}`, `reactRequestSchema` = `{reactions: Partial<Record<'❤️'|'🔥'|'😂'|'😮'|'👏'|'🛒', number>>}`, `pinRequestSchema` = `{productId, text, stockLeft?}`, `pinSchema` = `{version, productId, productTitle, text, stockLeft?, pinnedAt}`, `liveSnapshotSchema`, `liveHistoryPageSchema` = `{items, nextCursor}`):
  - `POST /shops/:shopId/live` (`ShopScoped('products.write')`) → `201 liveStreamSchema` `{id, shopId, title, status, launchEventId, startedAt, endedAt, createdAt}`.
  - `POST /shops/:shopId/live/:streamId/start`, `POST /shops/:shopId/live/:streamId/end` (`products.write`) → `200 liveStreamSchema`.
  - `PUT /shops/:shopId/live/:streamId/pin` (`products.write`) → `200 pinSchema`; `DELETE /shops/:shopId/live/:streamId/pin` → `204`.
  - `DELETE /shops/:shopId/live/:streamId/comments/:commentId` → `204`.
  - `POST /shops/:shopId/live/:streamId/mutes/:userId` → `204`; `DELETE /shops/:shopId/live/:streamId/mutes/:userId` → `204`.
  - `POST /live/:streamId/comments` (session) → `201 | 200 liveCommentSchema`.
  - `POST /live/:streamId/reactions` (session) → `202`.
  - `GET /live/:streamId` (anonymous, `s-maxage=1`) → `liveSnapshotSchema`; `GET /live/:streamId/history?minute&limit&cursor` (anonymous) → `liveHistoryPageSchema`.
  - `GET /live/:streamId/events` (anonymous, `text/event-stream`, hosted by the sse-gateway app): events `snapshot` `{status, pin, recent}`, `comments` `{items: LiveComment & {mine?: true}[], rate}`, `pin` `pinSchema | null`, `comment_removed` `{id}`, `status` `{status: 'LIVE' | 'ENDED'}`, `stats` `{second, reactions, viewers}`.
- Realtime topic registered by `LiveTopicsModule`: `stream:<id>` (public, control events `status`, `pin`, `comment_removed`, `stats` only). The private comment feed topic has no registered prefix.
- Events: on the event stream (key `streamId`, envelope `{eventId, type, version, occurredAt, aggregateId}`): `live.comment_posted` v1 `{streamId, commentId, authorId, authorName, text, at, priority?}`; `live.comment_removed` **v2** `{streamId, commentId, at, reason: 'moderator' | 'auto', actorId?, score?}`; `live.reactions_aggregated` v1 `{streamId, second, reactions}`. Through the outbox (topic `launch-events.events`, key `streamId`): `live.stream_started` v1 `{streamId, shopId, title, launchEventId, startedAt}`; `live.stream_ended` v1 `{streamId, shopId, endedAt, durationSeconds}`.
- Rate-limit policies (declared in S50's registry): `live.comment` 3 per 10 s per user (fail open), `live.reaction` 5 per second per user (fail open), `live.snapshot.ip` 120 per minute per address (fail open), `live.events.ip` 30 per minute per address (fail open).
- Job (registered with S49): `launch-events.live-reconcile` (every 30 s, concurrency 1, no payload).
- Modules for the apps: `LiveModule` (core: HTTP), `LiveWorkerModule` (worker: statistics publisher, reconcile job), `LiveProjectorModule` (projector: history writer, async moderation consumer), `LiveGatewayModule` (sse-gateway: event connection, sampler), `LiveTopicsModule` (sse-gateway: topic registration). Nothing else is exported: no model, repository, service class, key helper, sampler class or consumer class.

**Requires**:

- **S01** (`identity`): `Firewall({ anonymous? })`, `@User()` → `AuthenticatedUser = { id, role, sessionId, amr }`; on the gateway, the same optional authentication for the event connection (viewer's user ID for `mine`).
- **S03** (`tenancy`): `ShopScoped(permission)` with `products.write`; `ShopAccessService.getRole(shopId: ShopId, userId: UserId): Promise<ShopRole | null>` and `assertMember(shopId, userId, permission?)` (R1) with the role table where OWNER, ADMIN and STAFF hold `products.write`. No `ShopMembership` model access.
- **S05** (`catalog`): `ProductQueryService.getProductsByIds(ids: ProductId[], options?: { shopId?: ShopId }): Promise<Map<ProductId, ProductDto>>` (R1) with `ProductDto.{id, shopId, title, status}` and the status value for archived products.
- **S49** (job scheduler): recurring registration with single-run semantics.
- **S50** (rate limiter): the four policies above by name, with `Retry-After`.
- **S51** (realtime hub): `TopicRegistry.define({ prefix, suffixes?, policy })`, `RealtimePublisher.publish(topic, event, payload, { replay?: boolean })`, and — **asked, not in S51's Provides today** — a subscription facility usable by the gateway app, `TopicSubscriber.subscribe(topic, handler): Promise<() => Promise<void>>`, exported from the infrastructure lib (today it is app code in `apps/sse-gateway/src/topic-stream/`).
- **S52** (cache toolkit): cache-aside with single flight and negative caching for stream state.
- **S53** (events/outbox): `outbox.append(event)` inside the domain's own transaction (IX.6); projection/consumer framework with independent consumer groups, retries, dead-lettering; the plain event-stream producer for the high-volume `live.*` events (no relational transaction exists to be atomic with).
- **S54** (platform toolkit): problem+json filter with `code` and `requestId`, config validation at start, metrics registry, request context and `@Transactional`, graceful shutdown (the gateway closes viewers first).
- External: a toxicity classifier reached through a domain port and an `infra/` adapter (IV.8), default heuristic scorer, timeout 2 s.

Cross-domain data used by S23 (constitution IX.7): **R1** — tenancy's `ShopScoped` / `ShopAccessService` and catalog's `ProductQueryService`; **R2** — none (a future BFF screen composes `GET /api/live/:streamId`, `GET /api/launch-events/:eventId` and `GET /api/batch/products` over HTTP; this capability embeds no other domain's data in its responses beyond the `productTitle` copy in the pin); **R3** — none (no cross-domain filtering or sorting). The `productTitle` copy is taken at pin time under IX.8 and is not refreshed.

## Assumptions

- **Staff** means a member of the owning shop with `products.write` (OWNER, ADMIN, STAFF); a read-only member posts as an ordinary viewer (today every member, even read-only, gets priority).
- **"Friends' and highlighted comments"** of the notes: this platform has no social graph, so "friends" is not offered; "highlighted" is shop staff comments and the viewer's own comments.
- **Sampling constants** (250 ms window, 5 per window = 20 per second, 50 recent comments, 256 KB buffer, 50,000 viewers per instance, 15 s keep-alive, 15 s viewer-entry freshness, 5 s viewer report) come from the notes' scale model and are configuration with validated bounds.
- **Reactions are lossy by ≤ 1 second** on faults: counters live in the fast store for ten seconds; a crash of the fast store drops the current second only.
- **Chat is ephemeral for live delivery** (no replay); history is for replay by minute and audit, kept 30 days.
- **High-volume events** (`live.comment_posted`, `live.comment_removed`, `live.reactions_aggregated`) go straight to the event stream, not through the outbox, because a relational outbox write per comment would put 5,000 writes a second on the relational database against the notes' design; the low-volume lifecycle events use the outbox (IX.6).
- **History key**: the notes' `STREAM#<id>#<minute>` partition key is kept; write sharding inside a minute is a capacity decision for the plan.
- **Comment IDs** are time-ordered UUIDs so history writes and removals need no extra lookup key.
- **The pin's `stockLeft`** is staff-supplied; wiring it to flash-sale stock is S11/S21's business.
- **Authorization at connect time**: the event connection and the public topic are public by design (a launch stream is a public broadcast); the stream topic's policy therefore admits everyone and carries no comment or personal data.
- A shop whose status makes S03's guard refuse (suspended, deleted) cannot run staff actions; ending its live streams on deletion is S03's offboarding concern and not handled here.
- Banned terms are a platform-wide list in configuration; per-shop lists are not offered.
