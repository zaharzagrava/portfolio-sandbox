# SD-14 — Product Chat: Delivery Guarantees, Receipts, Presence, Unread (NestJS side)

Status: ☑ done (typechecked; spec written, not run) · Phase 4 · Depends on: F-03, SD-17 · Extends README #29–32 (Rust gateway — untouched, D1)

## Marketplace adaptation
Product chats exist (Rust WS gateway hot path, NestJS for channels/moderation/history). Missing WhatsApp-grade guarantees that can be added **without touching Rust**: sync-on-reconnect by sequence, unread counts, read receipts, presence, offline push.

## Existing code
`chat/` (channels, messages, moderation, ws-ticket), `ChatMessage` model (cursor pagination), Redis pub/sub backplane (Rust).

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Per-channel monotonic sequence** (`ChatChannel.lastSeq`, assigned via `UPDATE ... SET last_seq = last_seq + 1 RETURNING` — or a Postgres trigger so the Rust writer gets it for free) | 10/06 #14 |
| **Sync API**: `GET /chat/sync?since=<channelId:seq,...>` returns missed messages per channel — the delivery guarantee; push is best-effort | 10/06 #14 |
| Client message IDs → idempotent insert (`UNIQUE(channelId, clientMessageId)`) | 10/06 #14 |
| **Unread counts** = latestSeq − lastReadSeq per (user, channel) in Redis hash; `POST /chat/channels/:id/read {seq}` | 10/06 #14 |
| **Read receipts** published on the channel topic (Redis pub/sub — Rust gateway already relays channel topics) | 10/06 #14 |
| **Presence** heartbeat in Redis with TTL (`presence:{userId}` EX 60), throttled broadcasts | 10/06 #14 |
| Offline recipients → notification (SD-17) after 30 s undelivered (delayed SQS message, cancelled if read) | 10/06 #14 |
| Chat history partitioning: `ChatMessage` range-partitioned by month (big table) | 03/03 §4 |

## Steps
- [x] Migration: `seq` + `clientMessageId` columns, trigger assigning seq, unique index; `ChatReadState` (or Redis-only + periodic snapshot).
- [x] Sync endpoint, read endpoint, presence heartbeat endpoint + SSE fallback topic.
- [x] Offline notifier consumer.
- [x] e2e: insert messages seq 1..5, client synced to 3 → sync returns 4,5; read seq 5 → unread 0; duplicate clientMessageId → single row.

## Scale
- Target: 25k messages/s, 5M concurrent users (Rust gateway fleet), sync bursts on reconnect storms 50k RPS.
- Hot path: unread/presence → Redis only. Sync → indexed range scan `(channelId, seq)` on partitioned table + Redis cache of last 50 messages per hot channel.
- First bottleneck & fix: reconnect storm after gateway deploy → clients add jittered backoff; sync served from per-channel Redis cache for recent seqs.
- Capacity model: Postgres partitioned by month handles 25k inserts/s only with batching from the Rust writer (Rust untouched → documented as the next step: move history to Scylla `messages_by_channel(channel_id, bucket, seq)`).
- Proof: k6 sync storm; p99 < 100 ms.

## Implementation notes (2026-10-01)
- **Migration `20261001260000-chat-sequences`:**
  - A BEFORE INSERT trigger on `ChatMessage` runs `UPDATE "ChatChannel" SET "lastSeq" = "lastSeq" + 1 RETURNING` into `NEW.seq`. Seqs are gap-free and ordered per channel, and the Rust gateway's unchanged INSERT gets them too.
  - The same trigger writes a `chat.message_posted` envelope into the Outbox (a transactional outbox from inside the database).
  - Existing history is backfilled with `row_number()`.
  - Unique `(channelId, seq)` and partial unique `(channelId, clientMessageId)` are created CONCURRENTLY. `ChatChannelMember.lastReadSeq` is the durable read state.
- **`ChatSyncService`** (core):
  - `send`: idempotent `INSERT ... ON CONFLICT DO NOTHING` → the existing row; a foreign author gets 403. It publishes the exact Rust `ChannelEnvelope` JSON on `chat:channel:{id}`.
  - `sync`: one membership query, then gaps ≤ 50 are served from the tail cache keyed by `(channel, lastSeq)` (content-addressed, so there's no invalidation); bigger gaps use one `unnest + LATERAL seq > since LIMIT 201` query, with `hasMore` set when truncated. Deleted messages come back as tombstones.
  - `unread`: one indexed join.
  - `markRead`: `GREATEST`/`LEAST` (monotonic, capped); the receipt is published on SSE `chat:{id}` only when it advanced.
  - Presence: heartbeat `SET ... EX 60 GET`; broadcast only on the offline→online transition to the 20 most recent channels.
- **Receipts and presence travel on the F-03 SSE gateway** (new `chat:` topic, members-only policy), not on the Rust bus: Rust's `ChannelEnvelope` is a closed serde enum and drops unknown types (Rust untouched, D1).
- **Offline push:** `ChatOfflineScheduler` (projector, on the trigger's outbox event) enqueues per-recipient checks to SQS `chat-offline-notify` with a 30 s delay. Channels with more than 50 members (forum-like public product chats) are skipped. `ChatOfflineWorker` (worker) skips the check if the message was read or the user is online; otherwise it coalesces (one push per recipient and channel per 5 min) and dispatches SD-17 `chat.message`, a new type in the new `chat` category.
- **Endpoints:** `POST /api/chat/channels/:id/messages`, `POST /api/chat/sync`, `GET /api/chat/unread`, `POST /api/chat/channels/:id/read`, `POST /api/chat/presence/heartbeat`, `GET /api/chat/presence?userIds=`.
- **Spec** `chat-sync/chat-sync.e2e-spec.ts` covers: 20 concurrent "Rust" inserts → seqs 1..20 + 20 outbox events, sync tail vs DB path + non-member, idempotent send, monotonic read, and the offline-push decision table.
- **Not done:** monthly partitioning of `ChatMessage` (the PK would have to become `(id, createdAt)`, which touches the Rust insert's `RETURNING`). The documented next step at 25k msg/s is moving history to Scylla `messages_by_channel(channel_id, bucket, seq)`.
