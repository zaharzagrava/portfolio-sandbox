# Contract: S24 events and buses

## Domain events on `chat.events` (aggregate type `chat`; key `aggregateId`)

| Event | v | Payload | aggregateId / aggregateVersion | Writer | Consumers |
|---|---|---|---|---|---|
| `chat.message_posted` | 1 | `{channelId, messageId, seq, authorId, preview}` (preview ≤ 120 chars of the stored body) | `channelId` / `seq` | DB trigger (any writer), exception to IX.6 until 2027-03-31 (research R-03) | chat offline scheduler; S28, analytics may subscribe |
| `chat.message_escalated` | 1 | `{recipientId, channelId, channelTitle, messageId, seq, authorId, preview, dedupeKey}` | `recipientId` / — | `ChatOfflineCheckService` via `outbox.append` in its own transaction | S28 (dedupes on `dedupeKey`) |

- `eventId` of `chat.message_posted` is deterministic per message: UUID with the message id's 48-bit timestamp prefix, version `7`, variant `8`, tail `md5('chat-msg:' || messageId)`; the outbox row `id` equals it. Relays may repeat it; consumers dedupe on it.
- `dedupeKey` of `chat.message_escalated` = `chat:<recipientId>:<channelId>:<messageId>`; no author name, no e-mail; `preview` ≤ 120 chars.
- Definitions: `ChatMessagePosted`, `ChatMessageEscalated` (`defineEvent`) in `application/events/chat-events.ts`, zod payloads in `packages/contracts/src/chat/events.ts`; the `chat` aggregate is registered once (`EventsModule.forAggregates`) in the worker and the projector.
- Consumed: `tenancy.shop_deleted` v1 `{shopId}` (topic `tenancy.events`, key `shopId`) by `ChatShopPurgeConsumer`.

## Queue

`chat-offline-notify` (standard queue, existing; DLQ `chat-offline-notify-dlq`): body `{eventId, channelId, messageId, seq, authorId, recipientId, preview}`, `delaySeconds: 30`, `dedupeId: "<eventId>:<recipientId>"`; zod `bodySchema` on `consume` (invalid body → DLQ `SCHEMA_INVALID`). Both queue names must exist in `elasticmq.conf` (L-002); readiness fails while the consumed queue is missing.

## Realtime hub (S51)

Topic `chat:<channelId>` (prefix `chat`, members-only policy with UUID shape check, `replay: false` for both events): `read {userId, seq}`, `presence {userId, online: true, ttlSeconds: 60}`. Suppressed in channels with `activeMemberCount > 50`.

## Gateway-compatible live buses (formats unchanged; research R-08)

`chat:channel:<channelId>`: `message {channelId, message: {id, channelId, authorId, body, replyToId, createdAt}, seq?}`, `message_deleted {channelId, messageId}`, `channel_archived {channelId}`. `chat:moderation`: `ban|unban|mute|unmute|promote|demote {channelId, userId, mutedUntil?}`. Published after commit, best effort; failure → `chat_push_failed_total{kind}`; never fails the request.

## Jobs (S49)

`chat.partition-maintenance` (daily, single run, payload `{}`), `chat.backfill-shops` (on demand and every 10 min until no `shopId IS NULL` row remains, payload `{}`); both declared with `declareJobType`.
