# Real-Time and Collaboration Designs

Designs 14–18 of the practice catalog (`03-practice-catalog.md`). Common themes: **persistent connections** (WebSocket/SSE) across many server instances, delivery guarantees, ordering, and fan-out.

**Shared building block: a horizontally scaled connection layer**
```
clients ═══WebSocket/SSE═══► connection gateway pods (stateful: hold sockets)
                                   ▲        │ subscribe/publish
                                   │        ▼
                         pub/sub backplane (Redis pub/sub / Redis Streams / NATS / Kafka)
                                   ▲
                         app services publish events ("deliver to user X / channel Y")
```
- Each gateway pod holds tens to hundreds of thousands of idle connections (memory per socket matters more than CPU).
- A **connection registry** (Redis: `user → gateway pod(s)`) or topic-based pub/sub routes a message to the pod holding the recipient's socket.
- Load balancer: WebSocket support, long idle timeouts, heartbeats (ping/pong every ~30 s) to detect dead connections. Sticky sessions aren't needed when routing goes through the backplane.
- Deploys: draining pods disconnects users. Clients must reconnect with backoff and **resume from the last received event ID**.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [redis-pubsub](../../docs/humans/concepts/platform-redis-pubsub/redis-pubsub.md): The redis-pubsub platform module provides Redis Pub/Sub used to fan messages out across gateway instances.
> - [`ModerationEvent`](../../packages/hft-platform/src/protocol.rs#L186): ModerationEvent is the Redis pub/sub envelope the NestJS side publishes so the Rust WebSocket gateway can act on users in channels. _(protocol.rs)_
> - [`ChannelEnvelope`](../../packages/hft-platform/src/protocol.rs#L132): ChannelEnvelope is the Redis pub/sub envelope carrying channel events to whichever gateway instances hold the subscribed sockets. _(protocol.rs)_
<!-- theory-links:end -->

---

## 14. Chat app (WhatsApp / Slack)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ChatSyncService`](../../packages/backend/libs/domains/chat/application/chat-sync.service.ts#L40): ChatSyncService implements sending messages, history sync, read receipts and presence for chat. _(chat-sync.service.ts)_
<!-- theory-links:end -->

### Clarify
- 1:1 and group chats? Group size (WhatsApp ~1k, Slack channels 100k+)? Read receipts, typing indicators, presence, media, search, end-to-end encryption?
- Delivery semantics: messages must never be lost; ordering within a conversation.
- Scale: 50M DAU, 40 messages/user/day → 2B messages/day (~25k/s avg).

### Design
```
Client ══WS══► Gateway ─► Chat service ─► messages DB (partition key = conversation_id, sort = message seq)
                                │
                                ├─► for each recipient: online? → publish to their gateway (backplane)
                                │                       offline? → push notification (APNs/FCM)
                                └─► ack to sender: "stored" (single tick)
Recipient client ─► ack "delivered" / "read" ─► receipts
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ClientOp`](../../packages/hft-platform/src/protocol.rs#L24): ClientOp defines the frames a browser sends over the WebSocket: Subscribe, Send, Typing, Read and Ping. _(protocol.rs)_
> - [`ServerEvent`](../../packages/hft-platform/src/protocol.rs#L56): ServerEvent defines the frames the gateway pushes back to clients: Ready, Message, Typing and Pong. _(protocol.rs)_
> - [`ChatOfflineWorker`](../../packages/backend/libs/domains/chat/infra/chat-offline.ts#L65): ChatOfflineWorker notifies recipients who are offline and haven't read a message. _(chat-offline.ts)_
<!-- theory-links:end -->
### Deep dives
- **Message flow and guarantees**:
  1. Client sends with a **client-generated message ID** (UUID) → the server stores it idempotently (retries don't duplicate) → acks "sent".
  2. The server assigns a **per-conversation sequence number** (monotonic): the ordering source of truth, not client clocks.
  3. Delivery to online recipients via the gateway; the client acks receipt.
  4. Offline or disconnected clients **sync on reconnect**: "give me messages in my conversations after seq N". Push delivery is best-effort; the sync is the guarantee.
- **Storage**: write-heavy, append-only, queried by conversation + recent range → Cassandra/ScyllaDB/DynamoDB (partition by conversation, sort by seq) at very large scale; Postgres partitioned by time works well up to large sizes. Large groups: partition per (conversation, time bucket) so partitions don't grow unbounded.
- **Group fan-out**: small groups → deliver to each member's connection. Huge channels (Slack) → members fetch from the channel stream when they open it, plus lightweight "unread" notifications instead of pushing every message to everyone.
- **Presence and typing**: ephemeral, never stored in the main DB. Heartbeat-based presence in Redis with TTL (`presence:{user}` expires 60 s after the last heartbeat); typing indicators are fire-and-forget through pub/sub; throttle presence broadcasts (only to people viewing the conversation).
- **Unread counts**: per (user, conversation) last-read seq; unread = latest seq − last-read seq.
- **Media**: upload to S3 via presigned URL, send the message with a reference (design 27).
- **E2E encryption** (if asked): Signal protocol; the server stores only ciphertext, so server-side search becomes impossible.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SyncedMessage`](../../packages/backend/libs/domains/chat/application/chat-sync.service.ts#L9): SyncedMessage carries both the message id and the per-channel seq used for ordering. _(chat-sync.service.ts)_
> - [`ChannelSync`](../../packages/backend/libs/domains/chat/application/chat-sync.service.ts#L19): ChannelSync returns lastSeq and a hasMore flag, which is the resume/catch-up protocol after a reconnect. _(chat-sync.service.ts)_
> - [`ChatOfflineScheduler`](../../packages/backend/libs/domains/chat/infra/chat-offline.ts#L33): ChatOfflineScheduler schedules offline notification checks through SQS. _(chat-offline.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- WebSocket vs long polling vs SSE: chat is bidirectional and frequent, so WebSockets.
- Pitfalls: ordering by timestamps from clients; treating push notifications as delivery; storing presence in Postgres; no resume protocol (messages lost during reconnects).

### Theory
`04-API-Design/01` §2.8 (SSE vs WebSockets), `06-Distributed-Systems/01` (ordering, idempotency), `06-Distributed-Systems/03` (reconnect backoff).

---

## 15. Live comments / reactions on a live stream

### Clarify
- One stream can have millions of viewers; comment rate thousands per second on popular streams.
- Do all viewers need **all** comments? (No: humans can't read 5k comments/s.)

### Design
```
viewer POST /streams/:id/comments ─► comment service ─► store (async) + publish to stream topic
stream topic ─► fan-out tier (regional) ─► SSE/WebSocket gateways ─► viewers of that stream
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LiveBatcherRegistry`](../../packages/backend/apps/sse-gateway/src/live/live-batcher.service.ts#L95): LiveBatcherRegistry creates a batcher on the first local viewer and destroys it on the last, giving tiered fan-out through the gateway. _(live-batcher.service.ts)_
<!-- theory-links:end -->
### Deep dives
- **Read path dominates**: 1 comment × 1M viewers = 1M deliveries. Use **SSE** (viewers mostly listen; plain HTTP; auto-reconnect) through a tiered fan-out: the stream topic goes to regional fan-out nodes, which send to gateways, which send to sockets.
- **Sampling/rate-capping**: on huge streams, deliver a sample (e.g., 20 comments/s per viewer), always including friends' comments and highlighted ones. Reactions (hearts) are **aggregated** into counts per second instead of individual events.
- **Batching**: send comments in small batches every ~200–500 ms instead of one message per comment.
- **Moderation**: synchronous lightweight filter (banned words, rate limit per user) before publishing; async heavier moderation can remove comments afterwards (send "delete" events).
- **Late joiners**: load the last N comments from a cache, then subscribe.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`StreamBatcher`](../../packages/backend/apps/sse-gateway/src/live/live-batcher.service.ts#L28): StreamBatcher batches comments per stream on each gateway instance, sending on a 250ms tick. _(live-batcher.service.ts)_
> - [`SAMPLED_PER_TICK`](../../packages/backend/apps/sse-gateway/src/live/live-batcher.service.ts#L10): SAMPLED_PER_TICK caps delivery at 5 sampled comments per tick, which is the sampling and rate-capping idea. _(live-batcher.service.ts)_
> - [`LiveStreamController`](../../packages/backend/apps/sse-gateway/src/live/live-stream.controller.ts#L20): LiveStreamController serves live comments to viewers over SSE. _(live-stream.controller.ts)_
<!-- theory-links:end -->

### Theory
`04-API-Design/01` §2.8 (SSE), design 14 shared block, design 32 (aggregation).

---

## 16. Collaborative editor (Google Docs / Figma-lite)

### Clarify
- Text documents or structured canvases? Number of simultaneous editors per doc (usually < 50, rarely hundreds)? Offline editing? Version history, comments, permissions?

### Design
```
clients ══WS══► collaboration service (one "room" per document; all editors of a doc routed to the same instance)
                    │ apply/merge operations, broadcast to other editors in the room
                    ├─► operation log (append-only) + periodic snapshots ─► DB / S3
                    └─► presence/cursors (ephemeral)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`CollabServer`](../../packages/backend/libs/domains/catalog/api/collab-server.service.ts#L24): CollabServer is the WebSocket server for collaborative draft editing rooms, with auth and instance routing. _(collab-server.service.ts)_
> - [`Room`](../../packages/backend/libs/domains/catalog/application/room.ts#L39): Room holds an in-memory Y.Doc and handles sync, awareness, persistence and permissions. _(room.ts)_
> - [`DraftStore`](../../packages/backend/libs/domains/catalog/infra/draft-store.ts#L26): DraftStore persists collaborative doc snapshots and incremental updates. _(draft-store.ts)_
<!-- theory-links:end -->
### Deep dives
- **Conflict handling**: two users type at the same position at the same time.
  - **OT (Operational Transformation)**: the server orders operations and *transforms* concurrent ones against each other (e.g. shift an insert's index). Needs a central server; used by Google Docs.
  - **CRDTs** (Yjs, Automerge): data structures where concurrent operations merge automatically in any order, which works peer-to-peer and offline. Costs metadata overhead. Used by many modern editors (Figma uses a simpler server-authoritative last-writer-wins per property).
  - Practical answer for a web dev: **Yjs + a WebSocket provider (y-websocket/Hocuspocus)**, with the server persisting document updates.
- **Room routing**: all editors of a document must reach the same in-memory room. Use consistent hashing on document ID at the load balancer, or a room registry; on instance failure, rooms move and clients reconnect and resync.
- **Persistence**: append operations to a log for durability, compact into snapshots periodically (load = latest snapshot + subsequent ops). Version history = named snapshots.
- **Presence**: cursors and selections are ephemeral, broadcast but never persisted (Yjs awareness protocol).
- **Permissions**: check on room join *and* on each operation (viewer vs editor); revoke = kick from the room.
- **Large documents / offline**: CRDT state sync on reconnect (state vectors exchange only missing updates).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Room`](../../packages/backend/libs/domains/catalog/application/room.ts#L39): Room uses a Yjs Y.Doc, which is a CRDT that merges concurrent edits automatically. _(room.ts)_
> - [`MESSAGE_SYNC`](../../packages/backend/libs/domains/catalog/application/room.ts#L9): MESSAGE_SYNC is the protocol message type for Yjs sync updates. _(room.ts)_
> - [`MESSAGE_AWARENESS`](../../packages/backend/libs/domains/catalog/application/room.ts#L10): MESSAGE_AWARENESS is the protocol message type for awareness updates such as cursors and presence. _(room.ts)_
<!-- theory-links:end -->

### Trade-offs and pitfalls
- OT is simpler to reason about with a central server, but complex to implement correctly. CRDTs handle offline/P2P, at the cost of memory and metadata. Don't invent your own: use proven libraries.

### Theory
`06-Distributed-Systems/02` (consistency, conflict resolution), design 6 (offline sync).

---

## 17. Notification system

Full walkthrough: `02-worked-examples.md` Example 4. Points to rehearse:
- Producers emit domain events; the notification service resolves recipients, preferences, and templates, dedupes, and routes to **per-channel queues** (email, SMS, push, in-app), so one provider outage doesn't block the others (bulkhead).
- Providers: SES/SendGrid, Twilio, APNs/FCM; retries with backoff, provider failover, delivery-status webhooks.
- Priorities (transactional vs marketing), quiet hours and time zones (scheduled sends), rate limits per user ("max 3 pushes/hour"), unsubscribe and suppression lists.
- **In-app notifications**: a `notifications` table per user + unread count + real-time push over SSE/WebSocket (design 14 shared block).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`NotificationRouter`](../../packages/backend/libs/domains/notifications/application/notification-router.service.ts#L46): NotificationRouter routes notifications to email, push, SMS and in-app, with frequency caps and quiet hours. _(notification-router.service.ts)_
> - [`NotificationWorkers`](../../packages/backend/libs/domains/notifications/infra/notification-workers.service.ts#L25): NotificationWorkers consume the per-channel SQS queues, with deduplication and rate limiting. _(notification-workers.service.ts)_
> - [`Channel`](../../packages/backend/libs/domains/notifications/domain/catalog.ts#L5): Channel is the union of email, sms, push and inapp channels. _(catalog.ts)_
<!-- theory-links:end -->

---

## 18. Real-time leaderboard / live dashboard

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LiveDashboard`](../../packages/backend/libs/domains/seller-insights/infra/dashboard-ticker.service.ts#L11): LiveDashboard models the real-time shop dashboard metrics for the last 60 seconds and per-second order counts. _(dashboard-ticker.service.ts)_
<!-- theory-links:end -->

### Clarify
- Leaderboard: global or per game/region/period (daily/weekly)? Millions of players? Show top 100 + "my rank"?
- Dashboard: what metrics, update frequency (1 s vs 1 min), number of viewers?

### Design
- **Leaderboard**: Redis **sorted set** per board (`ZINCRBY lb:weekly userId points`, `ZREVRANGE 0 99 WITHSCORES` for the top, `ZREVRANK` for my rank, all O(log n)). Periodic snapshots to the DB; per-period keys (`lb:2026-W40`) with TTL. Ties: encode a tiebreaker into the score (e.g., score × 1e10 − timestamp).
  - Very large boards: shard by score range, or keep exact ranks only for the top N and approximate percentiles for everyone else.
- **Live dashboard**: events → stream processor (windowed aggregates per second/minute) → store aggregates (Redis / time-series DB) → push updates to dashboards over SSE every few seconds. Don't run `COUNT(*)` on the OLTP DB per viewer refresh.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LeaderboardService`](../../packages/backend/libs/domains/seller-insights/application/leaderboard.service.ts#L22): LeaderboardService is a Redis-backed top-k and rank service per period and category. _(leaderboard.service.ts)_
> - [`boardKey`](../../packages/backend/libs/domains/seller-insights/infra/leaderboard-keys.ts#L6): boardKey is the Redis sorted set key for a period's leaderboard scores. _(leaderboard-keys.ts)_
> - [`LeaderboardSnapshotJobs`](../../packages/backend/libs/domains/seller-insights/infra/leaderboard-snapshot.jobs.ts#L25): LeaderboardSnapshotJobs snapshots the top-100 entries on a schedule. _(leaderboard-snapshot.jobs.ts)_
<!-- theory-links:end -->

### Theory
`03-Databases/04` (sorted sets), design 32 (stream aggregation), `04-API-Design/01` §2.8 (SSE).
