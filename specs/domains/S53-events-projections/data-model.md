# Data model: S53

## Outbox (owner `infrastructure:outbox`, table `Outbox`) — expand-only migration
| Column | Type | Rule |
|---|---|---|
| id | uuid PK | row id; dedupe id for tasks |
| kind | text | `event` \| `task` (CHECK) |
| topic | text | topic or queue name, NOT NULL |
| aggregateId | text | NOT NULL (message key) |
| aggregateType | text | NOT NULL for events |
| type | text | lowercase dotted (CHECK for events) |
| payload | jsonb | event: the full envelope (CHECK `eventId` present); task: body, nulled after send |
| status | text | `pending` \| `published` \| `parked` (CHECK) |
| attempts | int | default 0 |
| nextAttemptAt | timestamptz | claim ordering |
| leaseUntil | timestamptz | claim lease (30 s) |
| parkedReason | text | code only, no payload |
| createdAt / publishedAt | timestamptz | |

Indexes: partial `(nextAttemptAt) WHERE status='pending'`; `(aggregateId, createdAt)` for holding; partial `(publishedAt) WHERE status='published'` for purge. Legacy columns (`extra`, `error`) stay until a contract migration. New CHECKs are added `NOT VALID` and validated in a later migration; every migration sets `lock_timeout` (III.11).

Transitions: `pending → published`; `pending → parked` (10 attempts or non-retryable); `parked → pending` (`requeueParked`, attempts reset).

## Inbox (owner `infrastructure:inbox`, table `ProcessedWebhookEvent`, name kept per IX.2)
`source`, `eventId`, `status` (`RECEIVED|PROCESSED|IGNORED|UNMATCHED|REJECTED|FAILED`), `attempts`, `claimedAt`, `handledAt`, `createdAt`; unique `(source, eventId)`. `claim` = insert-or-conditional-reclaim (`FAILED`, or `RECEIVED` older than 5 min) in one statement. `recordOnce(consumer, eventId)` uses `source = consumer`. Purge: terminal rows older than 30 days in bounded batches.

## Non-relational
- **Topic registration** (in memory): `{aggregateType, partitions (12; 64 hot), retention}`; topic `<aggregateType>.events`.
- **Checkpoint** (Redis): `ryw:{consumer}:{aggregateType}:{aggregateId}` → highest `aggregateVersion`, TTL 24 h.
- **Dead letter** (Kafka `<group>.dlq`): see `contracts/dead-letter.md`.
- **Projection activation** (Redis): `projection:active:{name}` → label; `…:previous` keeps the last one.
- **Redis doc**: `{v, deleted?, doc}`; a tombstone keeps `v`.

## Ownership registry
`db/ownership.ts`: `ProcessedWebhookEvent` owner `infrastructure:idempotency` → `infrastructure:inbox`; `Outbox` stays `infrastructure:outbox`.
