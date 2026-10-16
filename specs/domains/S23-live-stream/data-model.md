# Data Model: S23

## Postgres (expand-only migrations; tables owned by `launch-events`)

- **LiveStream** (existing, `db/ownership.ts:187`): `id UUID` (uuidv7), `shopId UUID NOT NULL` (**FK to `Shop` dropped**, IX.4), `title TEXT` (3–120), `status` `SCHEDULED|LIVE|ENDED`, `launchEventId UUID NULL` (plain ID, no FK), `startedAt`, `endedAt`, `createdAt`; **new** `pin JSONB NULL` = `{productId, productTitle, text, stockLeft?, pinnedAt}` and `pinVersion INT NOT NULL DEFAULT 0`. Index `LiveStream_shop_idx (shopId, createdAt DESC)` kept. No check constraint ties `pin` to `status`: ending clears the pin in the same conditional update.
- **LiveMute** (new): `streamId UUID NOT NULL REFERENCES "LiveStream"(id)`, `userId UUID NOT NULL` (no FK), `mutedBy UUID NOT NULL`, `mutedAt TIMESTAMPTZ NOT NULL DEFAULT now()`, PK `(streamId, userId)`. Registered as `LiveMute: 'domain:launch-events'` in `db/ownership.ts`.

### State machine (`domain/live-state.ts`)

| From \ To | LIVE | ENDED |
|---|---|---|
| SCHEDULED | transition, event `live.stream_started` | transition (cancel), `startedAt` stays null, `durationSeconds: 0`, event `live.stream_ended` |
| LIVE | no-op `200` | transition, clears `pin`, event `live.stream_ended` |
| ENDED | `409 stream_ended` | no-op `200` |

Each transition is `UPDATE "LiveStream" SET … WHERE id = :id AND "shopId" = :shopId AND status = :from` asserting one row; `pinVersion` is not reset on end.

## DynamoDB `LiveComments` (no key change)

`PK = STREAM#<streamId>#<yyyyMMddHHmm>`, `SK = commentId`; attributes `authorId`, `authorName` (handle), `text`, `at`, `priority?`, `removed?`, `removedReason?` (`moderator|auto`), `expiresAtEpoch` (post time + 30 days; a removal-only marker uses the id's time). Both event kinds are `UpdateItem` upserts.

## Redis (all derived, expiring; rebuildable)

| Key | Content | Lifetime |
|---|---|---|
| `live:{id}:state` (S52 cache entry) | `{shopId, status}`; negative entry for unknown IDs | 10 s negative, short positive |
| `live:{id}:recent` | last 50 comments (list) | trimmed |
| `live:{id}:pin` | cache of the durable pin | rebuilt on miss |
| `live:{id}:banned` | cache of `LiveMute` user IDs | rebuilt on miss and by the reconcile job |
| `live:active` | set of `LIVE` stream IDs for the publisher | rebuilt every 30 s |
| `live:{id}:viewers` | hash instance → `<count>:<ts>` | 60 s |
| `live:{id}:ticker` | statistics lease | 3 s |
| `live:rx:<id>:<second>:<shard>` | reaction counters, 8 shards | 10 s |
| `live:{id}:cid:<userId>:<clientId>` | comment ID for retries | 10 min |
| `live:{id}:rm:<commentId>` | removal claim | 24 h |
| `live:{id}:agg:<second>` | aggregation marker | 30 s |

## Value objects

- **Comment**: `{id (uuidv7), streamId, authorId, authorName (handle), text (normalized), at (epoch ms), priority?}`; viewers get `mine?: true` on a per-viewer copy.
- **Pin**: `{version, productId, productTitle, text, stockLeft?, pinnedAt}`.
- **Stats**: `{second, reactions, viewers}`.
- **Window**: `{priority[], own Map<userId, Comment[]>, sample (≤ k), seen}` per stream per instance.
- **Events** (`defineEvent`, envelope `{eventId, type, version, occurredAt, aggregateId}`): see [contracts/events-and-realtime.md](contracts/events-and-realtime.md).
