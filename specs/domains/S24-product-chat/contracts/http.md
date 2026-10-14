# Contract: S24 HTTP (under `/api`, every route `Firewall()`, session required)

Schemas live in `packages/contracts/src/chat/` (zod) and are the single source for DTOs, controllers' response parsing and the e2e assertions (VII.6). Errors are problem+json `{type, title, status, code, requestId, detail?}`; 5xx detail is generic. Every `:id` path segment is `ParseUUIDPipe` (`400 validation_failed`). Bodies use `forbidNonWhitelisted`. Limits are S50 policies (`429` + `Retry-After`; fail open).

| Route | Body / query | Success | Errors (code) | Policy |
|---|---|---|---|---|
| `POST /chat/channels` | `{productId, title?}` | `201 chatChannelSchema` | 400 `validation_failed`; 404 `product_not_found`; 403 `forbidden` (not a shop member with `products.write`); 409 `channel_exists`, 409 `product_archived` | `chat.channel-create.user` |
| `POST /chat/channels/:channelId/join` | — | `200 chatChannelSchema` | 404 `channel_not_found`; 403 `banned`; 409 `channel_archived` | — |
| `GET /chat/channels/by-product/:productId` | — | `200 chatChannelSchema` (`myRole: null` for non-members; public fields) | 404 `channel_not_found` | — |
| `GET /chat/channels/:channelId` | — | `200 chatChannelSchema` | 404 `channel_not_found` (also for non-members) | — |
| `PATCH /chat/channels/:channelId` | `{title?, isArchived?}` (at least one) | `200 chatChannelSchema` | 404; 403 `forbidden`; 409 `invalid_transition` | — |
| `POST /chat/channels/:channelId/messages` | `sendMessageRequestSchema` | `201` new / `200` replay: `sendMessageResponseSchema` | 400; 404; 403 `banned` / `muted` (+`mutedUntil`); 409 `channel_archived`; 422 `idempotency_key_reuse`, `reply_target_invalid` | `chat.send.user` |
| `GET /chat/channels/:channelId/messages` | `?limit=1..100&cursor` | `200 chatMessagePageSchema` (newest first, tombstones included) | 400; 404 | `chat.read.user` |
| `DELETE /chat/channels/:channelId/messages/:messageId` | — | `204` (idempotent) | 404 `channel_not_found`/`message_not_found`; 403 `forbidden` (rank) | — |
| `POST /chat/sync` | `chatSyncRequestSchema` `{cursors: Record<ChannelId, int 0..2^53-1>}` | `200 chatChannelSyncSchema[]` (unreadable channels omitted) | 400 `validation_failed`, 400 `too_many_channels` (> 50) | `chat.sync.user` |
| `GET /chat/unread` | `?limit=1..200&cursor` | `200 chatUnreadPageSchema` | 400 | `chat.read.user` |
| `POST /chat/channels/:channelId/read` | `markReadRequestSchema` `{seq}` | `200 markReadResponseSchema` | 400; 404 | `chat.read.user` |
| `POST /chat/presence/heartbeat` | — | `204` (also when the store is down) | — | `chat.heartbeat.user` |
| `GET /chat/presence` | `?userIds=<csv ≤ 100 UUIDs>` | `200 presenceResponseSchema` | 400; 503 `presence_unavailable` | `chat.presence.user` |
| `POST /chat/channels/:channelId/members/{ban,unban,promote,demote}` | `{userId}` | `204` | 400; 404 `channel_not_found`, `member_not_found`; 403 `forbidden`; 409 `invalid_transition` | — |
| `POST /chat/channels/:channelId/members/mute` | `{userId, minutes 1..43200}` | `204` | as above | — |
| `POST /chat/channels/:channelId/members/unmute` | `{userId}` | `204` | as above | — |
| `POST /chat/ws-ticket` | — | `201 chatWsTicketSchema` | — | `chat.ws-ticket.user` |

Notes
- `201` vs `200` on send: `201` and `duplicate: false` for a new message, `200` and `duplicate: true` for an identical replay (same author, same body and `replyToId`).
- Strangers (non-members, banned for reads, unknown channel) always get the same `404 channel_not_found` problem (no disclosure); banned members get `403 banned` only on **send** and **join**, as the spec says.
- Moderation answers `204` with no body; illegal repeats `409 invalid_transition`.
- `GET /chat/channels/by-product/:productId` is the only route readable without membership (R2 target of the BFF, S48).
- Route order in the controller: literal segments (`by-product`, `presence`, `unread`, `sync`, `ws-ticket`) before parametrised ones.

## Schemas (shape only; zod in `packages/contracts/src/chat`)

- `chatChannelSchema` `{id, productId, shopId, sellerId, title, isArchived, archivedAt|null, createdAt, updatedAt, myRole: 'OWNER'|'MODERATOR'|'MEMBER'|null}`
- `chatMessageSchema` `{id, seq: number, authorId, body: string|null, replyToId|null, createdAt, deleted: boolean}` (`body: null` iff `deleted`)
- `sendMessageRequestSchema` `{clientMessageId: uuid, body: string, replyToId?: uuid}`; `sendMessageResponseSchema` `{message, duplicate}`
- `chatMessagePageSchema` `{items: chatMessage[], nextCursor: string|null}`
- `chatSyncRequestSchema`, `chatChannelSyncSchema` `{channelId, messages, lastSeq, hasMore}`
- `chatUnreadPageSchema` `{items: {channelId, unread, lastSeq}[], nextCursor}`; `markReadRequestSchema`/`markReadResponseSchema` `{lastReadSeq, unread}`
- `presenceResponseSchema` `Record<UserId, {online: boolean, lastSeenAt: number|null}>`; `chatWsTicketSchema` `{ticket, wsUrl, expiresAt}`
- `chatErrorCodeSchema` enum of the codes above (used by e2e to assert `code`).
