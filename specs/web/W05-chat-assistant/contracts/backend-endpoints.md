# Backend endpoints used by W05

All under `/api`, same-origin through the BFF forwarder, session cookie + W01 CSRF header on writes. Schemas are in `packages/contracts`; **new** items are built by this plan (plan B-1…B-5).

## S24 chat (existing)

| Call | Response schema | Used by |
|---|---|---|
| `GET /chat/channels/by-product/:productId` | `chatChannelSchema` | resolver (AS-01..05) |
| `POST /chat/channels {productId, title?}` | `chatChannelSchema` | AS-04 |
| `POST /chat/channels/:id/join` | `chatChannelSchema` | AS-01 |
| `GET /chat/channels/:id` | `chatChannelSchema` (+ `myRole`) | conversation header, composer state |
| `GET /chat/channels/:id/messages?limit&cursor` | `chatMessagePageSchema` | AS-12, AS-13 |
| `POST /chat/channels/:id/messages` | `sendMessageResponseSchema` (`201`/`200 duplicate`) | AS-14..19 |
| `DELETE /chat/channels/:id/messages/:messageId` | `204` | AS-20 |
| `POST /chat/sync {cursors}` | `chatSyncResponseSchema` | catch-up (AS-25) |
| `GET /chat/unread?limit&cursor` | `chatUnreadPageSchema` | unread total fallback only |
| `POST /chat/channels/:id/read {seq}` | `chatMarkReadResponseSchema` | AS-31, AS-36 |
| `POST /chat/presence/heartbeat` | `204` | AS-34 |
| `GET /chat/presence?userIds=` | `presenceResponseSchema` | AS-34, AS-35 |

Problem codes handled: `validation_failed`, `channel_not_found`, `permission_denied`, `product_not_found`, `channel_exists`, `product_archived`, `banned`, `muted` (+`mutedUntil`), `channel_archived`, `idempotency_key_reuse`, `reply_target_invalid`, `rate_limited` (+`Retry-After`), `presence_unavailable`; unknown → FR-062.

## New (built here)

### B-1 `GET /chat/channels/mine?limit&cursor`

`limit` 1–100 (default 50), `cursor` opaque. Response `chatInboxPageSchema` = `{ items: (chatChannel & { unread: int ≥ 0, lastSeq: int ≥ 0, lastMessageAt: ISO | null })[], nextCursor: string | null }`. Rows: caller's `ACTIVE` memberships, archived included; order: not archived first, then `lastMessageAt` desc (null last), then id. `unread` uses the same computation as `/chat/unread`. Errors: `400 validation_failed` (limit/cursor), `401`. Rate policy: same family as `chat.read.user`.

### B-2 Hub events on `chat:<channelId>` (`replay: false`, members-only policy as `read`/`presence`)

| Event | Data | Published after |
|---|---|---|
| `message` | `{channelId, messageId, seq}` | a new message commit (not on idempotent replay) |
| `message_deleted` | `{channelId, messageId}` | a delete commit |
| `channel_archived` | `{channelId}` | an archive commit |

Best-effort: a hub failure never fails the write. Schema `chatHubEventSchema` (discriminated on `type`, includes existing `read {userId, seq}` and `presence {userId, online, ttlSeconds}`).

### B-3 `GET /chat/channels/:id/receipts`

Response `chatReceiptsSchema` = `{ items: { userId, lastReadSeq: int }[], suppressed: boolean }`: active members' positions; `suppressed: true` and `items: []` when the channel has more than 50 active members. Errors: `400` malformed id, `401`, `404 channel_not_found` for a non-member (same as other channel reads).

### B-4 (verify) S46 history id

`GET /assistant/conversations/:id/messages` → each assistant message `id` equals the `messageId` in the `meta` event of its stream.

## S46 assistant (existing)

| Call | Schema | Used by |
|---|---|---|
| `POST /assistant/conversations` / `GET` (keyset 20) / `DELETE /:id` | `assistantConversationSchema`, `assistantConversationListSchema` | AS-48, AS-61..63 |
| `GET /assistant/conversations/:id/messages` | `assistantHistorySchema` | AS-48, AS-51 |
| `POST /assistant/conversations/:id/messages` (`Idempotency-Key`, `{text, lat?, lng?}`) | SSE `assistantStreamEventSchema`; `Idempotent-Replay: true` on replay | AS-42..58 |
| `GET /assistant/messages/:messageId/stream` (`Last-Event-ID?`) | SSE | AS-49, AS-50, AS-54 |
| `POST /assistant/messages/:messageId/cancel` | `202 assistantCancelResponseSchema` | AS-52 |
| `GET /assistant/usage` | `assistantUsageSchema` | AS-47 |

Problem codes: `validation_failed`, `input_rejected` (+`category`), `turn_in_progress`, `conversation_full`, `not_found`, `generation_not_found`, `generation_finished`, `idempotency_in_flight` (+`messageId`), `idempotency_key_required`, `idempotency_key_reuse`, `rate_limited`, `too_many_active_turns`, `assistant_busy`, `assistant_unavailable`, `quota_exceeded` (+`used`,`limit`,`resetsAt`), `unauthenticated`.

## S51 stream

`GET /api/streams?topics=` through the shared connection (`lib/realtime/user-stream.ts`): events for `chat:<id>` (`message`, `message_deleted`, `channel_archived`, `read`, `presence`) and in-band `resync` / `revoked`.
