# Data model: S24 — Product chat

Owner of every table below: domain `chat` (ownership registry `db/ownership.ts`: `ChatChannel`, `ChatChannelMember`, `ChatMessage`, `ChatMessageIndex` new). All cross-domain references are plain UUID columns without foreign keys (IX.4, IX.8). Every migration sets `lock_timeout`, adds constraints `NOT VALID` then validates, and builds indexes `CONCURRENTLY` (III.11). Presence, checks, coalescing slots and caches are Redis/queue state, not tables.

## 1. Tables after the change

### `ChatChannel` (reshaped)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `productId` | UUID NOT NULL, **unique** | plain ID (FK to `Product` dropped, IX.4); one channel per product |
| `shopId` | UUID NOT NULL (after backfill) | plain ID (FK to `Shop` dropped, S03 A16); index `ChatChannel_shop_idx` exists |
| `sellerId` | UUID NOT NULL | creating user; plain ID (FK to `User` dropped) |
| `title` | text NOT NULL | 1–120 chars; default = product title at creation |
| `isArchived`, `archivedAt` | bool, timestamptz | transition by conditional update |
| `lastSeq` | BIGINT NOT NULL DEFAULT 0 | the channel's sequence counter (trigger) |
| `lastMessageAt` | timestamptz NULL | trigger |
| `activeMemberCount` | INT NOT NULL DEFAULT 0 | new; kept by the membership statements and the member trigger (R-11) |
| `deleteEpoch` | BIGINT NOT NULL DEFAULT 0 | new; incremented in the delete transaction; part of the cache key (R-10) |
| `createdAt`, `updatedAt` | timestamptz | |

Indexes: unique `(productId)` (exists); `(shopId)` (exists); new keyset index for the unread page on the member side (below).

### `ChatChannelMember` (reshaped)

`id`, `channelId` (FK → `ChatChannel`, kept: same owner), `userId` (plain ID, FK to `User` dropped), `role` `OWNER|MODERATOR|MEMBER`, `status` `ACTIVE|BANNED`, `mutedUntil`, `lastReadSeq BIGINT NOT NULL DEFAULT 0`, `lastReadAt`, `createdAt`, `updatedAt`.
Unique `(channelId, userId)` (exists); `(userId)` (exists). New: `ChatChannelMember_user_active_idx ("userId", "channelId") WHERE status = 'ACTIVE'` for co-membership and unread paging.
Check constraints (NOT VALID → validated): `lastReadSeq >= 0`.
Trigger `chat_member_count` (AFTER INSERT/UPDATE OF status/DELETE): adjusts `ChatChannel.activeMemberCount` — the gateway's create-if-absent statement is unchanged and still counted (AS-58).

### `ChatMessage` (partitioned, see R-02)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | uuidv7; PK `(id, createdAt)` |
| `channelId` | UUID NOT NULL | FK → `ChatChannel` (same owner) |
| `seq` | BIGINT **NOT NULL** | assigned by the trigger |
| `authorId` | UUID NOT NULL | plain ID (FK to `User` dropped) |
| `body` | text NOT NULL | 1–4,000 code points, stored trimmed |
| `replyToId` | UUID NULL | **self FK dropped** (not expressible on a partitioned table); validated in the insert statement (R-04) |
| `clientMessageId` | UUID NULL | NULL for gateway rows |
| `createdAt` | timestamptz NOT NULL DEFAULT now() | partition key |
| `deletedAt`, `deletedBy` | timestamptz, UUID NULL | `deletedBy` new |
| `editedAt` | dropped (unused, `questions.md` LOCAL) in the contract migration |

Partitions `ChatMessage_YYYY_MM` (UTC) from the oldest message month to current + 3, plus `ChatMessage_default`. Per-partition index `(channelId, seq)` unique, `(channelId, createdAt DESC)`.

### `ChatMessageIndex` (new, non-partitioned, cross-month guard and sync path)

`channelId UUID`, `seq BIGINT`, PK `(channelId, seq)`; `messageId UUID NOT NULL`, `createdAt timestamptz NOT NULL` (to prune the partition), `authorId UUID NOT NULL`, `clientMessageId UUID NULL`, `bodyHash bytea NOT NULL` (sha-256 of the stored body + `replyToId`, for the replay comparison, no body copy). Unique partial `(channelId, authorId, clientMessageId) WHERE clientMessageId IS NOT NULL`. Written only by the trigger. Retention follows `ChatMessage` (purge deletes by `channelId`).

### Outbox

Chat appends rows through `outbox.append` (`chat.message_escalated`) and, until 2027-03-31, through the trigger (`chat.message_posted`, R-03). `Outbox` stays owned by infrastructure; chat never reads it (tests may).

## 2. Trigger `chat_message_assign_seq` (replaced function, same trigger name)

BEFORE INSERT on `ChatMessage` (parent): (1) `UPDATE ChatChannel SET lastSeq = lastSeq+1, lastMessageAt = now() WHERE id = NEW.channelId RETURNING lastSeq INTO NEW.seq` (raise if no row); (2) `INSERT ChatMessageIndex (channelId, seq, messageId, createdAt, authorId, clientMessageId, bodyHash)` — unique violation here aborts the statement and rolls (1) back; (3) `UPDATE ChatChannelMember SET lastReadSeq = GREATEST(lastReadSeq, NEW.seq) WHERE channelId AND userId = NEW.authorId` (G-17); (4) outbox insert with deterministic `eventId` (R-03). All in the inserting transaction; a rolled-back send consumes nothing (FR-012).

## 3. Transitions

- Channel: `active ⇄ archived` (`UPDATE … WHERE isArchived = :from`, one row, else `409 invalid_transition`).
- Member status: `ACTIVE → BANNED → ACTIVE` (ban/unban); `mutedUntil` set/cleared (mute/unmute; unmute of an unmuted member is `409`); role `MEMBER ⇄ MODERATOR` (promote/demote); `OWNER` is never changed by an action. Each is a conditional update asserting one row.
- Message: `live → deleted` (`UPDATE … WHERE id AND channelId AND deletedAt IS NULL`); a repeat changes nothing, emits nothing, answers `204`.
- Read position: `lastReadSeq = LEAST(GREATEST(lastReadSeq, :seq), channel.lastSeq)`; an advance (row changed) publishes `read`.

## 4. Migrations (timestamps assigned at implementation, after `20261014130100`)

1. `chat-s24-expand`: columns (`activeMemberCount`, `deleteEpoch`, `deletedBy`), `ChatMessageIndex`, `ChatMessage_new` + partitions, member-count trigger, indexes (concurrently), `ChatChannel.shopId` already exists.
2. `chat-s24-backfill` (script/job, not DDL): batched copy of messages + index rows; `activeMemberCount`; run repeatably (`chat.backfill-shops` job is separate, R-12).
3. `chat-s24-contract`: guarded swap of `ChatMessage`, new trigger function, drop FKs to `Shop`, `User`, `Product`, self FK; `seq SET NOT NULL`; `shopId SET NOT NULL` (refuses while a NULL remains); drop `editedAt`.
4. `chat-s24-drop-old` (later, 2026-12-15): drop `ChatMessage_old`.
`down` restores the old function and renames back; it is tested only on a throwaway database.

## 5. Validation rules (from the spec)

Body trim + 1–4,000 code points; `clientMessageId` UUID; `title` 1–120; mute minutes 1–43,200; sync ≤ 50 cursors, each a UUID key and an integer in `0…2^53−1`; history `limit` 1–100 (default 50); unread `limit` 1–200 (default 50); presence ≤ 100 UUIDs; mark-read `seq` integer `0…2^53−1`; every path ID `ParseUUIDPipe`.

## 6. Cursors

History: opaque base64url of `{seq}` (`history-cursor.ts`; unsigned — it grants nothing, the membership predicate applies to every page); order `seq DESC`. Unread: opaque `{lastMessageAt, channelId}` keyset `(lastMessageAt DESC, channelId DESC)`. Tampered or malformed → `400 validation_failed`.
