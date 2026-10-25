# arch-42. Transactional outbox and idempotent consumers

*Distributed Systems · Medium*

## The question

"When a payment succeeds, the payments service updates Postgres and three consumers react: the ledger posts entries, notifications sends a receipt, and PMS sync posts the payment back to the landlord's PMS. Today the code is `await tx.commit(); await sns.publish(event)`, and about once a month an event goes missing or gets processed twice. Fix it. The goal is an exactly-once effect."

**Then:** "The PMS write-back API has no idempotency key, and sometimes it times out after it has already created the receipt. What do you do?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Volume? → assume: ~20 events/s normally, ~200/s on the 1st.
- Ordering needs? → assume: per payment yes (`succeeded` before `refunded`); across payments no.
- Transport today? → assume: SNS topic fanning out to one SQS standard queue per consumer.
- Where do consumers keep state? → assume: each consumer has its own Postgres schema or database.
- Latency? → assume: a few seconds is fine.
- Can we add Kafka? → assume: no; the volume doesn't justify it.

## Design

**Producer: write the event in the same transaction as the state change.**
```sql
outbox(id bigserial PRIMARY KEY, event_id uuid UNIQUE, aggregate_id uuid, type text,
       payload jsonb, traceparent text, created_at timestamptz DEFAULT now(),
       published_at timestamptz)
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```
`UPDATE payments SET status = 'succeeded' ...; INSERT INTO outbox ...; COMMIT;` Either both exist or neither.

**Relay (polling publisher), every ~200 ms or woken by `LISTEN/NOTIFY`:**
```sql
BEGIN;
SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;
-- publish to SNS (PublishBatch, 10 per call), message attribute event_id
UPDATE outbox SET published_at = now() WHERE id = ANY($ids);
COMMIT;
```
A crash after publish and before the update republishes the batch. That's allowed: delivery is at-least-once by design, and consumers dedupe.

**Consumer with a DB effect (ledger):**
```sql
BEGIN;
INSERT INTO processed_events (consumer, event_id) VALUES ('ledger', $1)
  ON CONFLICT DO NOTHING;              -- 0 rows → duplicate: COMMIT, delete message, stop
INSERT INTO ledger_entries ...;       -- the effect
COMMIT;                               -- then DeleteMessage
```
Dedupe record and effect commit together, so there's no window where one exists without the other.

**Consumer with an external effect (notifications, PMS):** pass `event_id` (or a key derived from it) as the provider's idempotency key; if the provider has none, see the twist.

**Ordering per payment:** consumers keep `last_version` per payment and ignore older events (events carry `payments.version`). If strict per-key order is needed in transport, SQS FIFO with `MessageGroupId = payment_id`.

**Failures:** each consumer queue has a DLQ (`maxReceiveCount` 5), an alert on depth > 0, and redrive after a fix. **Cleanup:** partition `outbox` by day, drop partitions older than 7 days.

## Deep dives

**1. Why `commit; publish` loses and duplicates.** Crash between commit and publish → state changed, event lost. Publish before commit → event for a change that may roll back. There's no transaction spanning Postgres and SNS. The outbox turns "change + event" into one Postgres write; publishing becomes a retryable background job.

**2. Polling relay vs CDC (Debezium).** Polling: simple, no new infrastructure, latency = poll interval, small query load on the partial index. One subtlety: sequence values are assigned at insert but transactions commit in a different order, so a relay that tracks "last published id" can skip a row that commits late. Selecting `WHERE published_at IS NULL` avoids that. Debezium reads the WAL in commit order with low latency, but adds Kafka Connect or Debezium Server and a replication slot to operate. Chosen: polling at ≤ 200 events/s; switch to CDC if latency or load demands it.

**3. Where to dedupe.** Chosen: `processed_events` in the consumer's own DB, same transaction as the effect. Rejected: Redis `SET NX` (not atomic with the effect: crash after SETNX and before the effect = lost event; crash after the effect = duplicate), SQS FIFO deduplication (5-minute window, and only dedupes sends, not processing), and payload-hash dedupe (two legitimate identical events collapse).

## Traps

- "SQS/Kafka gives exactly-once": SQS standard is at-least-once; FIFO dedup covers sends within 5 minutes; Kafka's exactly-once covers Kafka-to-Kafka processing, not your DB or an external API.
- Publishing from an `afterCommit` hook: still two separate writes; a crash in between loses the event.
- Dedupe check outside the effect's transaction.
- Deleting the SQS message before the consumer's transaction commits.
- No partial index or cleanup on `outbox`: the relay query slows down as the table grows.
- One DLQ shared by all consumers: you can't redrive for one consumer without re-running others.

## Say it (60–90 s)

The bug is a dual write: committing to Postgres and publishing to SNS are two operations, and a crash between them loses the event. I'd use a transactional outbox: in the same transaction that marks the payment succeeded, I insert the event into an outbox table. A relay process selects unpublished rows with SKIP LOCKED, publishes them to SNS in batches, and marks them published. If it crashes after publishing, it publishes again, so delivery is at-least-once, on purpose. That moves the problem to the consumers, and each one is made idempotent. The ledger consumer, in one transaction, inserts the event ID into a processed-events table with ON CONFLICT DO NOTHING, and only if the insert happened, writes the ledger entries; then it deletes the SQS message. A duplicate finds the row and does nothing. Consumers that call external APIs pass the event ID as the idempotency key. For order within one payment, events carry the payment's version and consumers ignore older ones. Each consumer has its own DLQ with an alert. So at-least-once delivery plus idempotent effects gives an exactly-once effect, which is the only "exactly-once" you can actually get.

## Follow-ups

**Q:** Then: the PMS has no idempotency key and times out after creating the receipt.
**A:** A timeout is "unknown", not "failed". Put our payment ID in a field they store (reference or memo). Before any retry, search their API by that reference; if it exists, record it and stop. If their API can't search, mark the write-back `unknown`, don't retry, and let a nightly reconciliation against their ledger resolve it or send it to manual review. A rare manual check is better than duplicate receipts in a landlord's books.

**Q:** How long do you keep `processed_events`?
**A:** Longer than any possible redelivery: SQS keeps messages at most 14 days, so 30 days, partitioned by day and dropped by partition.

**Q:** A new consumer needs past events.
**A:** The outbox only holds 7 days. For full history, rebuild from the source tables or keep an event archive in S3. Long replay is the point where Kafka's retention starts paying for itself.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
