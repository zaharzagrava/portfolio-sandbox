# arch-26. Transactional outbox and idempotent consumers

*Distributed Systems · Medium*

## The question

"When a customer places an order, the orders service commits it to Postgres and three consumers react: inventory reserves stock, notifications sends the confirmation email, and ERP sync posts the order to the merchant's ERP. Today the code is `await tx.commit(); await sns.publish(event)`. Every few weeks an order event goes missing (stock never reserved) or is processed twice (two emails, stock decremented twice). Fix it. The goal is an exactly-once effect."

**Then:** "The ERP API has no idempotency key, and sometimes it times out after it has already created the sales order. What do you do?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Volume? → assume: ~30 orders/s normally, ~400/s during sales.
- Ordering needs? → assume: per order yes (`placed` before `cancelled`); across orders no.
- Transport today? → assume: SNS topic fanning out to one SQS standard queue per consumer.
- Where do consumers keep state? → assume: each consumer has its own Postgres schema or database.
- Latency? → assume: a few seconds is fine for all three.
- Can we add Kafka? → assume: no; the volume doesn't justify it.

## Design

**Producer: write the event in the same transaction as the state change.**
```sql
outbox(id bigserial PRIMARY KEY, event_id uuid UNIQUE, aggregate_id uuid, type text,
       payload jsonb, traceparent text, created_at timestamptz DEFAULT now(),
       published_at timestamptz)
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```
`INSERT INTO orders ...; INSERT INTO outbox ...; COMMIT;` Either both exist or neither.

**Relay (polling publisher)**, every ~200 ms or woken by `LISTEN/NOTIFY`:
```sql
BEGIN;
SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;
-- SNS PublishBatch (10 per call), message attribute event_id
UPDATE outbox SET published_at = now() WHERE id = ANY($ids);
COMMIT;
```
A crash after publish and before the update republishes the batch. That is allowed: delivery is at-least-once by design, and consumers dedupe.

**Consumer with a DB effect (inventory):**
```sql
BEGIN;
INSERT INTO processed_events (consumer, event_id) VALUES ('inventory', $1)
  ON CONFLICT DO NOTHING;               -- 0 rows → duplicate: COMMIT, delete message, stop
UPDATE stock SET reserved = reserved + $qty WHERE sku = $sku;   -- the effect
COMMIT;                                 -- then DeleteMessage
```
The dedupe record and the effect commit together, so one can't exist without the other.

**Consumer with an external effect (email, ERP):** pass `event_id` (or a key derived from it) as the provider's idempotency key; if the provider has none, see the twist.

**Order per order:** events carry `orders.version`; consumers keep `last_version` per order and ignore older ones.

**Failures:** each consumer queue has its own DLQ (`maxReceiveCount` 5), an alert on depth > 0, and redrive after a fix. **Cleanup:** partition `outbox` by day, drop partitions older than 7 days.

## Deep dives

**1. Why `commit; publish` loses and duplicates.** Crash between commit and publish: the order exists, the event is lost. Publish before commit: an event for an order that may roll back. No transaction spans Postgres and SNS. The outbox turns "change + event" into one Postgres write; publishing becomes a retryable background job.

**2. Polling relay vs CDC (Debezium).** Polling is simple, needs no new infrastructure, and its latency is the poll interval. One subtlety: sequence values are assigned at insert, but transactions commit in a different order. A relay that tracks "last published id" can skip a row that commits late. Selecting `WHERE published_at IS NULL` avoids that. Debezium reads the WAL in commit order with low latency, but adds Kafka Connect or Debezium Server and a replication slot to operate. Chosen: polling at ≤ 400 events/s; switch to CDC if latency or relay load demands it.

**3. Where to dedupe.** Chosen: `processed_events` in the consumer's own DB, in the same transaction as the effect. Rejected: Redis `SET NX` (not atomic with the effect: a crash after SETNX and before the effect loses the event; a crash after the effect and before SETNX duplicates it). Rejected: SQS FIFO deduplication (5-minute window, dedupes sends, not processing). Rejected: payload-hash dedupe (two legitimate identical events collapse into one).

## Traps

- "SQS/Kafka gives exactly-once": SQS standard is at-least-once; FIFO dedup covers sends within 5 minutes; Kafka's exactly-once covers Kafka-to-Kafka processing, not your DB or an external API.
- Publishing from an `afterCommit` hook: still two separate writes; a crash in between loses the event.
- A dedupe check outside the effect's transaction.
- Deleting the SQS message before the consumer's transaction commits.
- No partial index or cleanup on `outbox`: the relay query slows down as the table grows.
- One DLQ shared by all consumers: you can't redrive for one consumer without re-running the others.

## Say it (60–90 s)

The bug is a dual write: committing to Postgres and publishing to SNS are two operations, and a crash between them loses the event. I'd use a transactional outbox. In the same transaction that inserts the order, I insert the event into an outbox table. A relay selects unpublished rows with SKIP LOCKED, publishes them to SNS in batches, and marks them published. If it crashes after publishing, it publishes again, so delivery is at-least-once, on purpose. That moves the problem to the consumers, and each one is made idempotent. The inventory consumer, in one transaction, inserts the event ID into a processed-events table with ON CONFLICT DO NOTHING, and only if the insert happened, reserves the stock; then it deletes the SQS message. A duplicate finds the row and does nothing. Consumers that call external APIs pass the event ID as the idempotency key. For order within one order, events carry a version and consumers ignore older ones. Each consumer has its own DLQ with an alert. At-least-once delivery plus idempotent effects gives an exactly-once effect, which is the only exactly-once you can actually get.

## Follow-ups

**Q:** Then: the ERP has no idempotency key and times out after creating the sales order.
**A:** A timeout is "unknown", not "failed". Put our order ID in a field the ERP stores and can search (external reference). Before any retry, search the ERP by that reference; if the order exists, record its ERP ID and stop. If the ERP can't search, mark the sync `unknown`, don't retry blindly, and let a nightly reconciliation against the ERP resolve it or send it to manual review. A rare manual check beats duplicate sales orders in the merchant's books.

**Q:** How long do you keep `processed_events`?
**A:** Longer than any possible redelivery. SQS keeps messages at most 14 days, so 30 days, partitioned by day and dropped by partition.

**Q:** A new consumer needs past events.
**A:** The outbox holds only 7 days. For full history, rebuild from the source tables or keep an event archive in S3. Long replay for many consumers is the point where Kafka's retention starts paying for itself.

</details>

## Theory in the notes

- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/02-transactions-isolation-locking.md](../../03-databases/02-transactions-isolation-locking.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
