# Messaging: SQS, Kafka, Delivery Semantics, Outbox/Inbox

Queues vs logs, delivery guarantees, SQS and Kafka in depth, the outbox/inbox patterns, ordering, and event design: how to avoid duplicates and lost messages.

---

## 1. Queue vs log

| | Queue (SQS, RabbitMQ) | Log (Kafka, Kinesis, Redis Streams) |
|---|---|---|
| Consumption | message deleted after ack | messages retained (time/size); consumers track **offsets** |
| Replay | no (except DLQ redrive) | yes: reset offsets, new consumers read history |
| Ordering | none (SQS standard) / per group (FIFO) | per **partition** |
| Fan-out | one consumer gets each message (use SNS → multiple SQS for fan-out) | many consumer groups each read everything |
| Scaling consumers | add consumers freely | parallelism capped by **partition count** |
| Typical | task/job distribution, decoupling, buffering | event streaming, event sourcing, CDC, analytics pipelines |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TaskQueue`](../../packages/backend/libs/infrastructure/sqs/task-queue.port.ts#L30): TaskQueue is the abstract queue port (enqueue, consume) the project uses for SQS-style queue consumption, as opposed to Kafka log consumption. _(task-queue.port.ts)_
> - [`projections/rebuild.ts`](../../packages/backend/scripts/projections/rebuild.ts): rebuild.ts resets Kafka consumer group offsets and replays topics from the beginning, which is the log-style replay a queue cannot do.
<!-- theory-links:end -->

### 1.1 Fan-out vs competing consumers

There are two different things you might want when several consumers read from one stream of messages:

**Competing consumers (work distribution)**: each message goes to **exactly one** of N identical workers. It's about **sharing the load** of the *same* job.
```
                      ┌─► worker 1   (gets msg 1, 4, 7 ...)
producer ─► [ queue ] ├─► worker 2   (gets msg 2, 5, 8 ...)
                      └─► worker 3   (gets msg 3, 6, 9 ...)
Example: 10,000 "resize this image" jobs, 3 identical resizer pods share them.
```

**Fan-out (broadcast)**: each message goes to **every** interested **subscriber**, and each subscriber is a *different* service doing a *different* job with the same event. Each gets **its own copy** and processes it independently: its own pace, its own retries, its own failures.
```
                           ┌─► email service       (sends confirmation)
"OrderPlaced" ─► [ topic ] ├─► inventory service   (reserves stock)
                           ├─► analytics pipeline  (records revenue)
                           └─► fraud check         (scores the order)
Example: one event, four independent reactions. The producer doesn't know or care who listens.
```
Why it matters: the producer stays decoupled. Adding a new consumer (say, a loyalty-points service) means subscribing to the topic, with **no change to the producer**. And a slow or broken subscriber (analytics is down) doesn't block the others, because each has its own copy and its own backlog.

Real systems usually **combine both**: fan out to each service, and inside each service use competing consumers across its pods.

**How each technology does it:**

| | Competing consumers | Fan-out |
|---|---|---|
| **SQS** (queue) | ✅ native: N consumers poll one queue; a received message is hidden from the others, then deleted | ❌ not on its own: once deleted, a message is gone for everyone. Use **SNS → several SQS queues** (one queue per subscribing service), or **EventBridge** rules → targets |
| **Kafka** (log) | ✅ **within one consumer group**: partitions are split among the group's consumers | ✅ **across consumer groups**: each group has its **own offsets** and reads **every** message; messages aren't deleted on read, so any number of groups can read the same log |
| RabbitMQ | ✅ several consumers on one queue | ✅ a *fanout/topic exchange* bound to several queues |
| Redis | Streams + consumer groups | Pub/Sub (no persistence) or several Streams consumer groups |

```
SNS + SQS fan-out (AWS)                          Kafka: fan-out across groups + competing consumers inside each
                 ┌─► SQS email-q ─► email pods          topic "orders" (3 partitions: P0 P1 P2)
SNS "orders" ────┼─► SQS stock-q ─► stock pods            ├─ group "email":     consumer A ← P0,P1   consumer B ← P2
                 └─► SQS analytics-q ─► ...               └─ group "analytics": consumer X ← P0,P1,P2
 each queue = independent copy, own DLQ/retries           each group reads ALL partitions; within a group each partition has ONE consumer
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FeedFanoutConsumer`](../../packages/backend/libs/domains/community/infra/fanout.consumer.ts#L21): FeedFanoutConsumer fans each feed item out to every active follower's timeline. _(fanout.consumer.ts)_
> - [`NotificationWorkers`](../../packages/backend/libs/domains/notifications/infra/notification-workers.service.ts#L25): NotificationWorkers consume SQS queues as competing workers, with deduplication and rate limiting. _(notification-workers.service.ts)_
<!-- theory-links:end -->

### 1.2 How SNS → SQS fan-out actually works
The producer **doesn't** write to an "origin queue". It **publishes to an SNS topic**, and SNS **pushes a separate copy** of each message into every subscribed SQS queue:
```
                         publish once
producer ─────────────► SNS topic "order-events"      (SNS does NOT store messages; it delivers and forgets)
                           │ subscription │ subscription │ subscription
                           ▼              ▼              ▼
                     SQS email-q    SQS stock-q    SQS analytics-q     ← each holds its OWN copy
                           │              │              │
                      email pods     stock pods     analytics pods     ← competing consumers per queue
```
- **Each queue gets a full, independent copy.** Consuming and deleting from `email-q` has no effect on `stock-q`. Each queue has its own backlog, visibility timeout, retries, DLQ, retention, and scaling. If analytics is down for a day, its queue buffers its copies (up to 14 days retention) while email keeps working.
- **"Completely copied", with two caveats:**
  - **Subscription filter policies** can give a queue only a *subset* (e.g. `stock-q` only receives `{"type": ["OrderPlaced", "OrderCancelled"]}`, filtering on message attributes or body). Then it isn't a full copy, just the events that service cares about.
  - By default SNS wraps the payload in its **own JSON envelope** (`{"Type":"Notification","Message":"<your JSON as a string>",...}`). Enable **raw message delivery** on the subscription to get your original body as-is.
- **SNS has no storage.** If a topic has no subscribers at publish time, the message is simply gone. The queues are what make it durable.
- **Ordered fan-out**: an **SNS FIFO topic** delivers into **SQS FIFO queues**, preserving `MessageGroupId` order and deduplication.
- **Setup detail**: each SQS queue needs an **access policy** allowing the SNS topic (`aws:SourceArn`) to `sqs:SendMessage`. A missing policy is the classic "messages vanish" bug.
- **If you really do have an existing queue that you want to fan out** (an "origin queue"), something has to consume it and republish (a Lambda, or **EventBridge Pipes** from SQS to SNS/EventBridge). That extra hop is why you **publish to the topic in the first place** when you know there will be several consumers.
- Alternative: **EventBridge** (a bus with content-based routing rules) → SQS targets. It's more flexible with routing, schema registry, and archive/replay, but has higher latency than SNS.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SnsVerifier`](../../packages/backend/libs/domains/notifications/api/sns-verifier.ts#L35): SnsVerifier verifies SNS HTTP deliveries (signature and certificate), the receiving end of SNS topic delivery. _(sns-verifier.ts)_
> - [`SnsMessage`](../../packages/backend/libs/domains/notifications/api/sns-verifier.ts#L4): SnsMessage describes the SNS delivery message structure received from a topic subscription. _(sns-verifier.ts)_
<!-- theory-links:end -->

---

## 2. Delivery semantics

- **At-most-once**: ack before processing, so a crash loses the message.
- **At-least-once**: ack after processing, so a crash causes **redelivery** and duplicates. ← the realistic default.
- **Exactly-once**: impossible end-to-end in general (two generals problem). What you can build is **effectively-once processing** = at-least-once delivery + **idempotent consumers**.
- Kafka "exactly-once semantics" (idempotent producer + transactions) applies **within Kafka** (read → process → write to Kafka atomically with offset commits). Side effects outside Kafka (DB writes, emails, HTTP) still need idempotency.
- **Exactly-once effect into your own DB: store the position in the DB.** Every record has a position: Kafka **offset** (per partition, contiguous integers), Kinesis **sequence number** (per shard, increasing but not contiguous). Consume a batch, write its effects **and** `UPDATE consumer_positions SET pos = <last> WHERE partition = …` in one DB transaction; on start, read the stored position and `seek` past it (don't rely on Kafka's own committed offset). A redelivered batch is at or below the stored position and is skipped. This is why logs suit batch consumers: one poll returns hundreds of records, one transaction applies them, one position covers them all. (SQS also receives up to 10 per call but has no position to store; use a processed-message-id table instead.)

Duplicates can enter a system at **two different points**, and each needs its own protection:
```
producer ──(1) send──► broker / log ──(2) deliver──► consumer ──► side effects
         duplicates from                duplicates from
         PRODUCER RETRIES               REDELIVERY (crash before ack/commit)
         → idempotent producer          → idempotent consumer
           (Kafka) / dedup ID (SQS FIFO)  (dedupe table, upserts; see §5)
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ClickAggregator`](../../packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#L43): ClickAggregator consumes clicks, aggregates them and writes results transactionally, giving effectively-once processing on top of at-least-once delivery. _(click-aggregator.service.ts)_ · [Aggregating and billing ad clicks](../../docs/humans/concepts/domain-marketing/ad-click-aggregation-and-billing.md)
> - [Exactly-once guarantee with UUIDv5, advisory lock, and existence check](../../docs/humans/concepts/domain-payments/exactly-once-settlement.md): Settlement journals use a deterministic UUIDv5 id, an advisory lock and an existence check so Kafka redeliveries post only once. [`SettlementListener`](../../packages/backend/libs/domains/payments/infra/settlement.listener.ts#L23)
<!-- theory-links:end -->

### 2.1 Idempotent producer: what problem it solves
**The failure:** the producer sends a batch to the broker, the broker **writes it to the log**, but the **acknowledgment is lost** (network blip, broker slow, request timeout). From the producer's side, "no ack" looks the same as "not written", so it **retries**, and the message is now in the log **twice**. A second problem: with several requests in flight, a failed-then-retried batch can land **after** a later batch, which **reorders** messages within a partition.

**The mechanism** (`enable.idempotence=true`, the default in the Java client since Kafka 3.0 and in librdkafka-based clients when configured):
1. When the producer starts, the broker gives it a **Producer ID (PID)**.
2. The producer numbers every batch it sends to each partition: **sequence number** 0, 1, 2, … per (PID, partition).
3. The broker remembers the last sequence number it wrote for each (PID, partition):
   - it receives a sequence it **already wrote** (a retry) → it **doesn't write it again**, but returns success, so the producer stops retrying;
   - it receives a sequence **with a gap** (e.g. 7 arrives before 6) → it rejects it, so the producer resends in order. That's how ordering is preserved even with up to 5 in-flight requests.

So "idempotent producer" = **sending the same batch twice has the same effect as sending it once**: exactly one copy in the log, in order.

**Limits (important in interviews):**
- It only covers **retries made by the Kafka client library itself** within one producer session. If **your application code** calls `send()` twice (your service crashed after sending but before recording that it sent, then reprocessed), that's two *different* messages with different sequence numbers, and both get written. That's why consumers still need to be idempotent.
- A **new PID after a restart** means the broker can't match retries from the old session, unless you use a `transactional.id` (next section).
- Per partition and per producer only. Two producers sending the same business event aren't deduplicated.
- SQS FIFO's equivalent is `MessageDeduplicationId` (§3).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`KafkaProducerService`](../../packages/backend/libs/infrastructure/kafka/kafka-producer.service.ts#L7): KafkaProducerService wraps the KafkaJS producer for single and batch sends. _(kafka-producer.service.ts)_
<!-- theory-links:end -->

### 2.2 Kafka transactions: "exactly-once" inside Kafka
For **consume → process → produce** pipelines (read from topic A, write results to topic B):
- The producer has a stable **`transactional.id`**. On restart it gets the same identity, and a new **epoch** that **fences off "zombie"** instances: an old instance that was thought dead but is still running gets its writes rejected.
- In one transaction it writes the output messages to topic B **and** commits the consumer offsets for topic A (`sendOffsetsToTransaction`). Either both happen or neither does.
- Downstream consumers with `isolation.level=read_committed` see only committed transactions.
- Result: every input message affects the output topics **exactly once**, even across crashes. **But** if processing also writes to Postgres, calls an API, or sends an email, Kafka can't roll those back. Those effects are outside the transaction, so you're back to at-least-once + idempotent consumers (or the outbox pattern).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Atomic write of aggregates and consumer offset in one Kafka transaction](../../docs/humans/concepts/domain-marketing/transactional-offset-commit.md): Minute aggregates and the consumer offset are committed in one Kafka transaction, so both succeed or the batch is redelivered. [`ClickAggregator`](../../packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#L43)
> - [`aggregateBatch`](../../packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#L21): aggregateBatch tags each aggregate with its source partition and first offset so re-writes are safe. _(click-aggregator.service.ts)_ · [Aggregating and billing ad clicks](../../docs/humans/concepts/domain-marketing/ad-click-aggregation-and-billing.md)
> - [`ADS_AGGREGATES_TOPIC`](../../packages/backend/libs/domains/marketing/infra/click-aggregator.service.ts#L8): ADS_AGGREGATES_TOPIC is the output topic the transaction writes to. _(click-aggregator.service.ts)_ · [Aggregating and billing ad clicks](../../docs/humans/concepts/domain-marketing/ad-click-aggregation-and-billing.md)
<!-- theory-links:end -->

---

## 3. AWS SQS deep dive

### Standard vs FIFO
| | Standard | FIFO |
|---|---|---|
| Throughput | nearly unlimited | default: **300 API calls/s per action** (Send, Receive, Delete each) = 3,000 msg/s with batches of 10. **High-throughput mode**: up to 70,000 calls/s (700k msg/s batched) in us-east-1/us-west-2/eu-west-1, much less in smaller regions (2,400 calls/s in most). Limits are per queue; you can shard across queues |
| Ordering | best-effort | strict **per `MessageGroupId`** |
| Duplicates | possible (at-least-once) | dedup within **5-minute** window via `MessageDeduplicationId` or content-based |

**Big picture first:** companies running 100k+ msg/s on SQS use **standard** queues (no fixed limit). FIFO is a special queue type where strict order costs throughput, so it has quotas. A **message group** is just a label you put on each message (`MessageGroupId: "account-42"`); SQS keeps order only among messages with the same label. Why "next one only after the previous is deleted"? Because that *is* strict order: if SQS handed `account-42 #2` to worker B while worker A still works on #1, B could finish first and order would break. So: one group = one single-file line, many groups = many lines served in parallel (like checkout lanes).

```
STANDARD queue, 2 workers                     FIFO queue, group = account
t0  A takes acc42#1 (slow, 300 ms)            t0  A takes acc42#1 (in flight)
t0  B takes acc42#2 (fast, 50 ms)             t0  B asks: acc42#2 is NOT handed out (its group is busy),
t50 B applies #2  ← before #1: order broken          B gets acc7#1 instead (other group = parallel)
t300 A applies #1                              t300 A deletes acc42#1 → acc42#2 becomes available
```
Ordering can also live **outside** the queue: if the message is only a wake-up ("account 42 has events") and the worker locks the account's cursor row in the DB and applies events by sequence number, two workers waking for the same account can't break order (the second finds the row locked and exits). Then a standard queue is enough, and often **no queue at all**: if the data already sits in a Postgres table, workers can poll it with `FOR UPDATE SKIP LOCKED` (Postgres as a queue: pg-boss, graphile-worker). A broker in front of a table is just a doorbell plus a dual write (insert + send can't share a transaction), so you'd need a DB poller as a safety net anyway. Add the broker for latency, fan-out to other services, or volume beyond one DB.

Two separate FIFO limits apply at the same time:
1. **Queue-wide API quota** (the table row above): e.g. 300 `SendMessage` calls/s for the whole queue in default mode.
2. **Per-group serialization**: a group has one batch in flight and gets the next only after you delete it, so one group's speed ≈ batch size / processing time (100 ms handler, batch of 1 ⇒ ~10 msg/s for that group). It doesn't matter how high the queue quota is.
So total throughput ≈ min(queue quota, number of active groups × per-group rate). Parallelism comes from **many groups**; one hot group is slow whatever the quota. A webhook integration (~tens of msgs/s spread over many accounts) is far below both.

FIFO ordering per group: messages in a group are processed **one at a time**. A stuck message **blocks its group** while it retries, so pick group IDs at the right granularity (e.g. per account rather than one global group).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EnqueueOptions`](../../packages/backend/libs/infrastructure/sqs/task-queue.port.ts#L1): EnqueueOptions carries the FIFO groupId and deduplicationId plus delaySeconds. _(task-queue.port.ts)_
> - [`processBatch`](../../packages/backend/apps/lambdas/src/shared/sqs-batch.ts#L26): processBatch handles SQS batches while respecting FIFO ordering. _(sqs-batch.ts)_
<!-- theory-links:end -->

### `MessageGroupId`: ordering per group (like a Kafka partition key, but finer)
**`MessageGroupId` guarantees order within that group**, the same role a **message key → partition** plays in Kafka.
```ts
await sqs.send(new SendMessageCommand({
  QueueUrl: FIFO_URL,                              // queue name must end in .fifo
  MessageBody: JSON.stringify(event),
  MessageGroupId: `account-${event.accountId}`,    // order guaranteed per account
  MessageDeduplicationId: event.eventId,           // see next section
}));
```
How it behaves:
- Messages with the **same group ID** are delivered **strictly in send order**, and **only one batch per group is in flight at a time**. SQS won't hand out the next message of group `account-42` until the in-flight ones are **deleted** (processed) or their **visibility timeout expires** (then they're redelivered, still first in line).
- **Different groups are independent** and can be processed in parallel by different consumers.
- A failing message keeps retrying at the head of its group (blocking only **that** group) until `maxReceiveCount` sends it to the DLQ. ⚠️ After that, the group continues **without it**, so ordering for that entity is broken. Decide whether that's acceptable, or whether you need to pause and alert.
- Group choice: per **entity whose events must stay ordered** (account, order, user). One global group gives strict total order but **zero parallelism**. Random group IDs give parallelism but no useful ordering.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EnqueueOptions`](../../packages/backend/libs/infrastructure/sqs/task-queue.port.ts#L1): EnqueueOptions exposes the FIFO groupId used as MessageGroupId. _(task-queue.port.ts)_
> - [`processBatch`](../../packages/backend/apps/lambdas/src/shared/sqs-batch.ts#L26): processBatch keeps messages of the same group in order and reports only the failed IDs. _(sqs-batch.ts)_
<!-- theory-links:end -->

### `MessageDeduplicationId`: producer-side dedupe (SQS's "idempotent producer")
**Problem it solves** (the same as §2.1): your app calls `SendMessage`, SQS stores the message, but the response times out, so your code or the SDK **retries the send**. Without protection, the queue now has two copies.

**How it works:**
- Each FIFO send carries a **deduplication ID** (up to 128 characters).
- If SQS receives another message with the **same dedup ID within 5 minutes** of the first one, it **accepts the call** (returns success, same as the original) but **doesn't enqueue it again**.
- This holds even if the first copy has already been consumed and deleted, as long as you're still inside the 5-minute window.
- Two ways to set it:
  - **explicit**: pass `MessageDeduplicationId`. Use a **stable business ID** (`eventId`, outbox row ID, `${orderId}:${version}`) so every retry of the same logical event carries the same ID. **Don't** generate a new random UUID per attempt, because that defeats the purpose.
  - **content-based deduplication** (a queue setting): SQS uses a **SHA-256 of the message body** as the ID (message attributes aren't included). It's convenient, but two *legitimately different* events with identical bodies within 5 minutes get merged, so include a unique ID or timestamp in the body.
- Not unique to SQS, but each broker does it differently: Azure Service Bus "duplicate detection" (`MessageId`, configurable window), NATS JetStream (`Nats-Msg-Id` header, window), Kafka's idempotent producer (sequence numbers, retries of one producer session only). RabbitMQ has none built in. All of them are **producer-retry protection over a short window**, never a replacement for an idempotent consumer.
- Scope: per queue by default. In **high-throughput FIFO** mode it can be scoped per message group (`DeduplicationScope=messageGroup`).

**What it does NOT do:**
- It doesn't prevent **consumer-side** duplicates. If your consumer crashes before deleting a message, the visibility timeout expires and the message is **redelivered**, which is normal at-least-once behavior. Consumers still need idempotency (§5).
- It doesn't help **after 5 minutes**. A replay an hour later (outbox relay re-sending after a long outage) creates a duplicate.
- It doesn't exist for **Standard** queues, which can deliver duplicates even without any retry on your side.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`EnqueueOptions`](../../packages/backend/libs/infrastructure/sqs/task-queue.port.ts#L1): EnqueueOptions has a deduplicationId, mapped to the SQS FIFO MessageDeduplicationId. _(task-queue.port.ts)_
<!-- theory-links:end -->

### SQS FIFO message groups vs Kafka partitions
In Kafka it's also **one consumer per partition** (within a consumer group), so both systems serialize processing per ordering unit. The difference is **what that unit is** and how work is assigned:

| | SQS FIFO message group | Kafka partition |
|---|---|---|
| What defines the unit | the **`MessageGroupId`** you set: can be **one per entity** (millions of groups is fine) | a fixed number of partitions per topic (e.g. 12); **many keys hash into the same partition** (`hash(key) % partitionCount`) |
| Ordering scope | per group (= per entity) | per partition (= for **all keys** that share it) |
| Who processes it | **no fixed owner**: any consumer can receive the group's next message once the previous ones are deleted. SQS hands out groups dynamically | **one consumer in the group owns the partition** until a **rebalance** reassigns it. A consumer can own several partitions |
| Head-of-line blocking | a stuck message blocks **only its own group** (one entity) | a stuck message blocks **the whole partition**: every other key hashed there waits too (unless you skip it, park it in a retry topic, or process keys in parallel inside the consumer) |
| Max parallelism | ≈ number of active groups (and your consumer count) | **= number of partitions** in the topic. Extra consumers in the group sit idle; raising the partition count later **changes key → partition mapping** (it breaks ordering during the change) |
| Position tracking | none: messages are deleted after processing | consumer **offset** per partition; messages stay for replay |
| Fan-out | no: one queue = one set of consumers (use SNS → several FIFO queues) | yes: another consumer group reads the same partitions independently |

So: **"one consumer per partition"** in Kafka is per *consumer group*, and a partition is a **coarse** ordering bucket shared by many keys. An SQS FIFO group is a **fine-grained** ordering unit (one entity), handed to whichever consumer is free. Kafka gives you replay, fan-out, and much higher throughput. SQS FIFO gives you per-entity ordering with less head-of-line blocking and no partition planning.

### Visibility timeout
- When a consumer receives a message, it becomes invisible for the `VisibilityTimeout`. If it isn't deleted in that time, **it reappears** and gets processed again.
- Set it **longer than the maximum processing time** (for Lambda: at least 6× the function timeout, per AWS guidance). For long jobs, **extend** it periodically with `ChangeMessageVisibility` (a heartbeat).
- Too short means duplicate processing. Too long means slow retries after a crash.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ConsumeOptions`](../../packages/backend/libs/infrastructure/sqs/task-queue.port.ts#L18): ConsumeOptions sets visibilityTimeoutSec, concurrency and long-poll wait time. _(task-queue.port.ts)_
> - [`SqsTaskQueue`](../../packages/backend/libs/infrastructure/sqs/sqs-task-queue.ts#L17): SqsTaskQueue runs a heartbeat that extends message visibility during long processing. _(sqs-task-queue.ts)_
> - [`CatalogImportWorker`](../../packages/backend/libs/domains/catalog-sync/infra/catalog-import.worker.ts#L13): CatalogImportWorker uses a heartbeat to keep queue visibility for long import jobs. _(catalog-import.worker.ts)_
<!-- theory-links:end -->

### DLQ and redrive
- `maxReceiveCount` (e.g. 5): after N failed receives, the message moves to the **dead-letter queue**.
- Alert on **DLQ depth > 0**, investigate, fix, then **redrive** (the console or `StartMessageMoveTask` API).
- Poison messages (always fail, e.g. a malformed payload) belong in the DLQ quickly rather than blocking or wasting retries.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TaskMessage`](../../packages/backend/libs/infrastructure/sqs/task-queue.port.ts#L11): TaskMessage carries receiveCount, which is used to decide retries and dead-lettering. _(task-queue.port.ts)_
> - [`OutboxService`](../../packages/backend/libs/infrastructure/outbox/outbox.service.ts#L11): OutboxService retries failed events and routes them to a dead-letter queue. _(outbox.service.ts)_
<!-- theory-links:end -->

### Lambda + SQS event source mapping
- Lambda polls SQS in batches (`BatchSize`, `MaximumBatchingWindowInSeconds`).
- **Partial batch failures**: enable `ReportBatchItemFailures` and return `{ batchItemFailures: [{ itemIdentifier: messageId }] }`. Otherwise a single failure **retries the whole batch**, and messages that already succeeded run again.
  ```ts
  export const handler: SQSHandler = async (event) => {
    const failures: SQSBatchItemFailure[] = [];
    await Promise.all(event.Records.map(async (r) => {
      try { await processIdempotently(JSON.parse(r.body), r.messageId); }
      catch (e) { logger.error({ e, id: r.messageId }); failures.push({ itemIdentifier: r.messageId }); }
    }));
    return { batchItemFailures: failures };
  };
  ```
- **Maximum concurrency** on the event source mapping protects downstream systems (an LLM API rate limit, or DB connections). Lambda × DB connections → use RDS Proxy.
- Long polling (`WaitTimeSeconds=20`) reduces empty receives and cost.
- Message size limit: 256 KiB historically (AWS raised it to 1 MiB in 2025). For larger payloads, use the **claim-check pattern**: store the payload in S3 and send the pointer.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`processBatch`](../../packages/backend/apps/lambdas/src/shared/sqs-batch.ts#L26): processBatch returns only the failed message IDs, giving partial batch failure reporting. _(sqs-batch.ts)_
> - [`SqsBatchResponse`](../../packages/backend/apps/lambdas/src/shared/sqs-batch.ts#L12): SqsBatchResponse is the batchItemFailures response shape. _(sqs-batch.ts)_
> - [`src/main.ts`](../../packages/backend/apps/lambda-local/src/main.ts): The local Lambda simulator polls SQS, invokes handlers and handles batch failures with visibility timeouts. · [lambda-local](../../docs/humans/concepts/app-lambda-local/lambda-local.md)
<!-- theory-links:end -->

### Example: email → LLM parsing → downstream system pipeline
```
Email ingestion → S3 (raw .eml) → SQS "parse-requests" → Lambda (LLM parse) → SQS "parsed-records" → target-system sync worker
                                        │ failures ×N                                    │
                                        ▼                                                ▼
                                      DLQ (alarm)                                      DLQ (alarm)
```
Points to make: claim check (S3) for large emails; idempotency per email message-ID (dedupe table) so retries don't create duplicate records; LLM calls are slow and flaky, so set the visibility timeout above the LLM timeout plus margin, plus partial batch failures, plus backoff on 429s; concurrency limits for LLM rate limits; validate structured LLM output against a schema and route invalid output to a review queue rather than retrying forever; observability via queue age (`ApproximateAgeOfOldestMessage`), DLQ depth, and per-stage success rates.

---

## 4. Kafka deep dive

- **Topic** → **partitions** (ordered, append-only logs) → replicated across brokers (`replication.factor=3`, `min.insync.replicas=2`, producer `acks=all` for durability).
- **Key** → partition (hash). **All events for one key stay in order** (key by `accountId` to order an account's events).
- **Consumer group**: each partition is consumed by exactly one consumer in the group, so max parallelism = number of partitions.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`HOT_KEY_SALTS`](../../packages/backend/libs/domains/marketing/application/ads.service.ts#L13): HOT_KEY_SALTS spreads ad click keys over 10 partitions to avoid hot partitions. _(ads.service.ts)_ · [Ad click tokens and fraud checks](../../docs/humans/concepts/domain-marketing/ad-click-tracking-and-fraud.md)
> - [`ADS_CLICKS_TOPIC`](../../packages/backend/libs/domains/marketing/application/ads.service.ts#L11): ADS_CLICKS_TOPIC is the Kafka topic for click events, keyed by campaign. _(ads.service.ts)_ · [Ad click tokens and fraud checks](../../docs/humans/concepts/domain-marketing/ad-click-tracking-and-fraud.md)
> - [`createKafka`](../../packages/backend/libs/infrastructure/kafka/kafka-client.factory.ts#L9): createKafka builds the Kafka client with environment-specific SSL/SASL configuration. _(kafka-client.factory.ts)_
<!-- theory-links:end -->

### 4.1 How partitions are split among consumer group members
Every consumer that subscribes with the same **`group.id`** joins one **consumer group**. Kafka **divides the topic's partitions among the group's members**: each partition gets **exactly one** owner in the group, and a member can own **several** partitions. That's how a Kafka group does "competing consumers": the work is shared **per partition**, not per message (SQS shares per message).

Topic `orders` with **6 partitions** (P0–P5), group `billing`:
```
1 consumer:   C1 ← P0 P1 P2 P3 P4 P5         (one consumer reads everything)
2 consumers:  C1 ← P0 P1 P2   C2 ← P3 P4 P5   (load split in half)
3 consumers:  C1 ← P0 P1   C2 ← P2 P3   C3 ← P4 P5
6 consumers:  C1 ← P0 ... C6 ← P5             (max parallelism: one partition each)
7 consumers:  C1..C6 as above, C7 ← nothing   (IDLE: there's no partition left for it)
```
Two rules that are easy to mix up:
- **"One consumer per partition"** (per group): two members of the same group never read the same partition at the same time. That's what keeps per-partition ordering intact.
- **But one consumer can have many partitions.** So the number of consumers can be anything from 1 up to the partition count. Beyond that, extra consumers sit idle (handy as hot standbys, useless for throughput).

How the assignment happens:
- When a member **joins, leaves, crashes** (missed heartbeats, `session.timeout.ms`), or **stops polling** too long (`max.poll.interval.ms`), the group **rebalances**: partitions are redistributed among the current members. A scale-up from 2 to 3 pods moves some partitions to the new pod.
- The **assignment strategy** decides who gets what: `range`, `roundrobin`, `sticky` (keep existing assignments where possible), **`cooperative-sticky`** (move only the partitions that have to change, without stopping everyone; the recommended default). Kafka 4.0 made the new **consumer rebalance protocol (KIP-848)** generally available, which moves assignment to the broker and avoids "stop-the-world" rebalances.
- After a reassignment, the new owner continues from the **last committed offset** of that partition. Anything the previous owner processed but hadn't committed yet gets **processed again**, which is why consumers must be idempotent.
- Different groups are independent: group `billing` and group `analytics` each get their own full split of all 6 partitions (that's the fan-out from §1.1).

Sizing consequence: **choose partition count up front for your max expected parallelism** (e.g. 12–48 for a busy topic). You can add partitions later, but that changes `hash(key) % partitions`, so keys move to different partitions and per-key ordering breaks during the transition.
- **Offsets**: committed per partition. Commit **after** processing (at-least-once). Auto-commit can commit messages that haven't been processed yet.
- **Rebalancing**: when consumers join or leave, partitions get reassigned. Use cooperative sticky assignment and static membership to cut disruption. A long processing step without polling makes you exceed `max.poll.interval.ms`, so you're kicked from the group, which triggers a rebalance and duplicates.
- **Idempotent producer** (`enable.idempotence=true`, the default in modern clients) stops duplicates from producer retries.
- **Retention**: by time or size. **Log compaction** keeps the latest value per key (changelog/state topics).
- **Retries without blocking the partition**: retry topics with delays (`orders.retry.1m`, `orders.retry.10m`) plus a DLQ topic. Ordering trade-off: a retried message goes out of order.
- **Lag** = latest offset − committed offset per partition. It's the key metric to alert on.
- Node clients: `kafkajs` (pure JS, maintenance has slowed), `@confluentinc/kafka-javascript` (librdkafka-based, actively maintained), `node-rdkafka`.

<!-- theory-links:start -->
> [!TIP] In this codebase
<!-- theory-links:end -->

---

## 5. The dual-write problem and the transactional outbox

```ts
// ❌ Dual write: DB commit succeeds, publish fails (or vice versa) → inconsistency
await db.insert(order);
await sqs.send(orderCreated);   // crash here = event lost forever
```

### Transactional outbox
```sql
CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  aggregate_type text, aggregate_id text,
  event_type text, payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON outbox (created_at) WHERE published_at IS NULL;
```
```ts
await db.transaction(async (tx) => {
  await tx.insert('orders', order);
  await tx.insert('outbox', { id: uuidv7(), event_type: 'OrderCreated', aggregate_id: order.id, payload: order });
}); // atomic: both or neither
```
**Relay** (a separate process):
- Polling: `SELECT ... WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`, publish, mark published. Publishing is at-least-once (a crash after publish but before marking means a duplicate), so consumers must be idempotent.
- Or **CDC** (Debezium reads the outbox table's WAL and publishes to Kafka), which gives lower latency and no polling load.
- Clean up published rows periodically (or partition the table by day and drop old partitions).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OutboxPublisherService`](../../packages/backend/libs/infrastructure/outbox/outbox-publisher.service.ts#L27): OutboxPublisherService drains unpublished outbox rows to Kafka with retries and leasing. _(outbox-publisher.service.ts)_
> - [`Outbox`](../../packages/backend/libs/infrastructure/outbox/outbox.model.ts#L70): The Outbox model stores events with Kafka publish metadata and retry state. _(outbox.model.ts)_
> - [Settling the payment and recording the ledger](../../docs/humans/concepts/domain-payments/settle-method.md): Payment settlement publishes its responses through the outbox in the same transaction as the ledger write. [`PaymentResolutionJobs`](../../packages/backend/libs/domains/payments/infra/payment-resolution.jobs.ts#L29)
<!-- theory-links:end -->

### Inbox / idempotent consumer
```ts
await db.transaction(async (tx) => {
  const inserted = await tx.query(
    `INSERT INTO processed_messages (consumer, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    ['invoice-generator', msg.id]);
  if (inserted.rowCount === 0) return;                // duplicate → skip
  await applyBusinessLogic(tx, msg);                  // same transaction as dedupe record
});
// ack/delete message AFTER commit
```
Alternatives: **naturally idempotent operations** (upsert by business key, `SET status='paid' WHERE status='pending'`), or a version check (`WHERE version < $eventVersion`).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Idempotent creation of the payment row](../../docs/humans/concepts/domain-payments/idempotent-payment-insert.md): The Payment row is inserted with ON CONFLICT (idempotencyKey) DO NOTHING, so duplicate messages share one row. [`PaymentService.executePayment`](../../packages/backend/libs/domains/payments/application/payment.service.ts#L65)
> - [Redis balance projection from ledger events](../../docs/humans/concepts/domain-payments/balance-projection.md): BalanceProjector applies each journal once, with idempotency per journal, so event redelivery is harmless. [`BalanceProjector`](../../packages/backend/libs/domains/payments/infra/balance.projector.ts#L26)
<!-- theory-links:end -->

---

## 6. Ordering

- Global ordering doesn't scale. Order **per entity** (Kafka key / SQS FIFO group).
- Even with ordered delivery, **retries and parallel consumers** reorder things. Defensive consumers:
  - Carry a **sequence number or version** per aggregate, and ignore stale events (`if event.version <= current.version: skip`).
  - Or make events "thin" (`InvoiceUpdated {id}`) so the consumer fetches the current state, which makes order irrelevant.
- A FIFO queue only preserves the order messages were **enqueued** in. If the source (e.g. a partner's webhooks) already delivers out of order, FIFO can't fix it: use the version guard. Worked example: [webhook receive pipeline](../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md#consuming-webhooks-the-reliable-receive-pipeline).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Projector`](../../packages/backend/libs/infrastructure/projections/projector.ts#L7): Projector consumes events in order per partition. _(projector.ts)_
> - [`EventEnvelope`](../../packages/backend/libs/infrastructure/events/event-envelope.ts#L23): EventEnvelope is the common envelope that carries the event metadata consumers use. _(event-envelope.ts)_
<!-- theory-links:end -->

---

## 7. Event design

| Type | Payload | Pros | Cons |
|---|---|---|---|
| Event notification | `{ type: 'InvoicePaid', id }` | small, no schema coupling | consumers call back (chatty, coupling at runtime) |
| Event-carried state transfer | full/partial state | consumers autonomous (local copy) | bigger, schema evolution matters |
| Domain event (event sourcing) | the fact itself, used as source of truth | full history, replay | complexity, snapshots, versioning |

- **Schema evolution**: Avro or Protobuf plus a schema registry with compatibility modes (BACKWARD: new consumers read old data; FORWARD; FULL). For JSON, use JSON Schema with additive-only changes.
- Every event carries: `eventId` (UUID), `type`, `version`, `occurredAt`, `source`, `correlationId`/`traceparent`, `aggregateId`, `sequence`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`eventEnvelopeSchema`](../../packages/backend/libs/infrastructure/events/event-envelope.ts#L11): eventEnvelopeSchema is the Zod schema that validates every event envelope field. _(event-envelope.ts)_
> - [`defineEvent`](../../packages/backend/libs/infrastructure/events/define-event.ts#L24): defineEvent creates strongly typed events with a schema and tracing context. _(define-event.ts)_
> - [The link.clicked event and its payload](../../docs/humans/concepts/domain-marketing/link-clicked-event.md): LinkClicked is a versioned event with a defined payload. [`LinkClicked`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts#L17), [`share-link.service.ts`](../../packages/backend/libs/domains/marketing/application/share-link.service.ts)
<!-- theory-links:end -->

---

## 8. Backpressure and flow control for consumers

- Bound in-flight work: SQS batch size × concurrency, Kafka `max.poll.records`, a pause/resume API.
- Protect downstream with concurrency limits plus a circuit breaker. When the downstream system is down, **stop consuming** instead of burning through retries into the DLQ.
- Autoscale consumers on **queue depth/age** (KEDA in K8s, Lambda scales automatically) rather than CPU.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProjectionRunner`](../../packages/backend/libs/infrastructure/projections/projection-runner.service.ts#L26): ProjectionRunner applies retries, backpressure and lag metrics to Kafka projections. _(projection-runner.service.ts)_
> - [`SinkBackpressureError`](../../packages/backend/libs/infrastructure/projections/projector.ts#L22): SinkBackpressureError tells the runner to pause the partition and retry. _(projector.ts)_
> - [`QueueMetricsService`](../../packages/backend/libs/infrastructure/sqs/queue-metrics.service.ts#L15): QueueMetricsService publishes SQS queue depth and message age as gauges for autoscaling. _(queue-metrics.service.ts)_
<!-- theory-links:end -->

---

## 9. Choosing: SQS vs SNS vs EventBridge vs Kafka

- **SQS**: work queues, buffering, retry/DLQ. Simple and serverless.
- **SNS**: pub/sub fan-out to multiple SQS, Lambda, HTTP, or email targets (SNS + SQS fan-out pattern).
- **EventBridge**: an event bus with content-based routing rules, schema discovery, SaaS integrations, archive and replay. Higher latency than SNS.
- **Kafka (MSK / Confluent)**: high-throughput streams, replay, multiple independent consumer groups, stream processing, CDC. More operational effort.

### Three ways to build a queue: Postgres, SQS, Kafka

Everything below can be built on all three; what differs is **how much you build yourself** and **how coarse the blocking is**. Rent-payments examples throughout.

#### 1. Postgres table as a queue ("transactional inbox" / jobs table)
**How it's built:** a table (`jobs` or `inbound_events` + a cursor table). Workers loop (~1 s when idle) and claim rows with `SELECT … FOR UPDATE SKIP LOCKED` (see [locks §5](../03-databases/02-transactions-isolation-locking.md#5-row-level-locks)). Libraries: pg-boss, graphile-worker, or your own (`claimJobs` in this repo). Two styles:
- **hold the lock for the transaction** (short DB-only work, e.g. applying ordered events): crash → rollback → the work is still there. No reaper.
- **claim, commit, then work** (slow work, external calls like Stripe): set `status = RUNNING, locked_until = now + lease`, commit, do the work, mark `DONE`. A dead worker's job is re-claimed when its lease expires, either inside the claim query (`OR (status = 'RUNNING' AND locked_until < now())`) or by a separate reaper that also counts attempts and marks `DEAD`.

**Properties**
- **Created in the same transaction as business data**: yes, directly ("payment row created ⇒ charge job exists", one INSERT).
- **Retries, backoff, dead letter**: you write them (`attempts`, `retry_after`, `status = failed/DEAD`), or a library does. A few columns and one `WHERE`.
- **Scheduled far ahead**: any `run_at` (autopay on the 1st of next month, retry in 6 h).
- **Query / edit / cancel single items**: plain SQL: "why wasn't tenant X charged?", cancel a tenant's pending charge, reschedule, "jobs stuck > 1 h by customer", "pause everything for customer Y", "is a charge for this lease already pending?".
- **Fairness**: hard caps in the claim query (e.g. ≤ 20 running per tenant; this repo caps per shop and per type), so a 50k-unit customer on rent day gets its share, not everything.
- **Strict order**: by any column, including the **partner's sequence**, and it can **wait for a missing #41** (it's just "is row #41 here yet?").
- **Stop on failure**: per **entity** (account): its cursor doesn't move, the claim query skips it, everyone else keeps flowing. Visible in SQL, lasts until a human resumes it.
- **Volume**: roughly 1k–few k jobs/s per database; beyond that polling and row churn (dead tuples, VACUUM) hurt. Can shard by account later.
- **Spikes**: fine for moderate bursts.
- **Many consumers of the same item**: no (one claimer per row). Fan out by publishing from an outbox to SNS/Kafka.
- **Retention / replay**: kept until you delete it.
- **Costs**: polling load on the DB; you own the code or library; jobs share the business DB's capacity.
**Pick it when** jobs must be born with business data, scheduled far ahead, inspected/edited, fairly shared, or **strictly ordered with per-entity stop-on-failure** (PMS event ingestion), at moderate volume.

#### 2. SQS queue
**How it's built:** the producer sends a message (in practice: an **outbox** row in the business transaction + a relay that sends it, since your DB and SQS can't share a transaction). Consumers long-poll; a received message becomes invisible for the **visibility timeout** (a lease); the consumer deletes it when done. Standard queue: near-unlimited throughput, at-least-once, rough order. FIFO queue: order per `MessageGroupId`.

**Properties**
- **Created in the same transaction**: in two stages (outbox + relay).
- **Lease / crash recovery**: built in: the visibility timeout expires and the message reappears. No reaper.
- **Retries, dead letter**: built in: `maxReceiveCount` → DLQ, redrive later.
- **Scheduled far ahead**: no: `DelaySeconds` max 15 min (use EventBridge Scheduler or a table for longer).
- **Query / edit single items**: no: only approximate counts; you can't find, change or delete one message.
- **Fairness**: **fair queues** (since 2025): standard queue + `MessageGroupId = tenant`; while one tenant has a backlog, others are served first. Best-effort, no hard caps.
- **Strict order**: FIFO only, per `MessageGroupId`, **arrival** order; it can't wait for a missing message.
- **Stop on failure**: no real stop. FIFO blocks the group while retrying, then the DLQ takes the message and the group **continues** (skips). Without a DLQ it retries until retention runs out and the message is **deleted**. No "pause one group" API.
- **Retention**: **4 days by default, max 14**: a buffer, never a store.
- **Volume / spikes**: standard is near-unlimited; FIFO 300 calls/s per action by default (high-throughput mode far more). Absorbs rent-day spikes; autoscale workers on queue depth.
- **Many consumers**: one consumer group per queue; fan out with SNS → several queues.
- **Costs**: outbox + relay for transactional creation; no visibility into individual items; managed, cheap.
**Pick it when** work items are **independent** (order doesn't matter), you want managed retries/DLQ/autoscaling, volume is high or spiky, or another team's service does the work. Example: "charge payment 9", "send receipt email", "post payment back to the PMS".

#### 3. Kafka topic
**How it's built:** a log split into partitions; a message's key picks the partition (`hash(key) % N`). Each partition is read **in order** by exactly one consumer in a group, which remembers its position (committed offset). Producers publish from an outbox via a relay or Debezium (CDC), with the idempotent producer on. Many consumer groups can each read everything.

**Properties**
- **Created in the same transaction**: in two stages (outbox/CDC + relay). Kafka transactions cover Kafka only, not your DB.
- **Lease / crash recovery**: a crashed consumer's partitions are reassigned; the new owner re-reads from the last committed offset.
- **Retries, dead letter**: not built in for classic consumer groups. Your consumer code chooses: retry in a loop (blocks the partition), skip (commit: the message is lost to this consumer), or copy it to retry/DLQ topics you build (easy with an outbox, but for an ordered stream moving on = skipping).
- **Scheduled far ahead**: no.
- **Query / edit single items**: no (scan only; index via ksqlDB or a DB sink).
- **Fairness**: no caps. Keys are **hashed into a fixed set of shared partitions** (say 24), so a heavy tenant slows every tenant in its partition.
- **Strict order**: per partition (= per key), **arrival** order, **only if every message carries a key**: the producer sends `key = account` to partition `hash(key) % N`, so all of account A's events land in one partition and are read by one consumer, in order. Without a key the producer spreads messages across partitions and order is lost. There is no order *across* partitions (account A vs account B), which you don't need. Waiting for a missing #41 needs consumer-side state (Kafka Streams state store).
- **Stop on failure / head-of-line blocking**: each partition holds a **mix** of accounts read strictly in order, so one stuck account blocks **every account in its partition**. One partition per account isn't practical: partition counts are fixed and costly (files, replication, rebalances), adding partitions remaps `hash(key) % N` for all keys, and they can't be removed. Dedicated topics/partitions work only for a few "whale" tenants.
- **Retention / replay**: configurable, hours to forever; new consumers can replay history (build a new read model, reprocess after a bug).
- **Volume**: 100k–millions of messages/s.
- **Many consumers**: yes, the main strength: each consumer group reads everything at its own pace.
- **Costs**: a cluster (MSK/Confluent), relay or CDC, lag monitoring, partition planning.
**Pick it when** many consumers need the same **facts** (`PaymentCompleted` → ledger, analytics, notifications, search), you need replay, or volume is huge, and per-partition head-of-line blocking is acceptable (failures are rare and can be parked or skipped: analytics, logs, CDC, projections).

### Why is there no "perfect" broker? The trade-off underneath

**Kafka is fast because the partition is the only unit it tracks**: one committed offset per partition per consumer group, sequential disk reads, no per-message state on the broker. Every feature we want beyond that needs **state per message or per key**: per-message ack and redelivery (queues), per-key progress (isolation), per-tenant counters (fairness). That state costs memory, disk writes and coordination, so something must hold it: the **broker** (SQS, Service Bus, Pulsar, Pub/Sub, Kafka share groups), a **consumer-side layer** (Parallel Consumer, uForwarder), or **your database** (a Postgres queue). It can be moved, not removed. That's why no broker has Kafka's raw throughput *and* per-key isolation for free.

**1. Unordered, log-based, with history, without HTTP: these exist**
| System | What it is |
|---|---|
| **Kafka share groups** ("Queues for Kafka", KIP-932; production-ready in 4.2) | the Kafka log + queue semantics: per-message accept/release/reject, redelivery after a lock timeout, delivery-count limit, consumers beyond the partition count. No ordering, no built-in DLQ yet |
| **Apache Pulsar**, `Shared` subscription | log storage (BookKeeper) with retention/replay, per-message ack, built-in retry and dead-letter topics, delayed delivery |
| **RabbitMQ** quorum queues / **Streams** | AMQP over TCP; Streams are an append-only log with replay |
| **NATS JetStream** | persisted streams over TCP; consumers with per-message ack, max deliveries, backoff; work-queue or keep-history retention |
| **Redis Streams** | append-only log; consumer groups with per-message `XACK`, a pending list, `XAUTOCLAIM` to take over a dead consumer's messages |
| **Google Pub/Sub** | gRPC, per-message ack, retention with replay (`seek`) |
SQS's HTTP overhead is mostly amortized (long polling, batches of 10, keep-alive); its real limits are ~10–50 ms per call and deleting messages after processing, which rarely matter for jobs.

**2. Ordered with per-key isolation: also exists, natively or as a layer**
| Option | How | Catch |
|---|---|---|
| **Azure Service Bus sessions** | messages with the same `SessionId` are processed in order by one receiver holding the session lock; other sessions are independent | per-session throughput is one consumer; Azure-specific |
| **SQS FIFO message groups** | order per `MessageGroupId`; a stuck group blocks only itself | DLQ skips; ≤ 14 days retention; arrival order only |
| **Google Pub/Sub ordering keys** | order per key; a redelivery replays that key's later messages | 1 MB/s publish per key; an unacked key can still delay others; DLQ breaks order |
| **Pulsar `Key_Shared`** | same key → same consumer, keys spread dynamically across consumers (not tied to partitions) | known stall cases around redelivery; operational complexity |
| **Kafka + Confluent Parallel Consumer** (Java, open source) | processes different keys of one partition concurrently, in order per key; a slow or failing key only holds itself | per-key bookkeeping in the consumer; Java |
| **Kafka + Uber uForwarder** (open source push proxy) | pushes each message to services over gRPC, per-message retries, DLQ, detects and clears head-of-line blocking | built for throughput and isolation, not strict per-key order |
| **Kafka + parking lot / retry topics** | on failure record "key parked", divert its later messages to a parking topic, others continue, replay when fixed | you own the parked-keys store and the replay tooling |
| **Postgres per-entity cursor** | each account is a row; claim with `SKIP LOCKED` | thousands/s per DB; shard beyond |
| **Workflow engines** (Temporal) | one workflow per account serializes its steps natively | a different programming model and a cluster to run |

**The three Kafka isolation layers compared** (all isolate, each with its own cost):
| | Confluent Parallel Consumer | Uber uForwarder | Parking lot / retry topics |
|---|---|---|---|
| Isolates | slow and failing keys: a key retries with backoff on its own; other keys keep processing | slow and failing messages: per-message retries, DLQ, automatic clearing of head-of-line blocking | a failed key is **stopped completely**; its later messages wait in the parking topic, others continue |
| Order per key | yes (`KEY` mode) | not guaranteed | yes, if replay drains the parked messages before the key goes live again |
| Costs | Java only; per-key queues in memory; the committed offset can't pass the oldest unfinished record (it stores finished offsets in commit metadata), so a key failing for long pins the partition's offset: memory grows and the record risks outliving topic **retention** | another component to run (a push proxy calling services over gRPC); ordering given up | you build it: a store of parked keys checked on **every** message, extra topics, replay tooling, and a race-free hand-over from "parked" back to "live" |
| Fits | high-throughput ordered streams where failures are rare and transient | async job processing on Kafka where ordering doesn't matter | money streams where one entity must stop and wait for a human |
| Solves the **noisy neighbour** (one account's 50k backlog delaying others)? | **no**: one key's records are processed one at a time and fill the look-ahead buffer, so fetching further stalls | **no** (and unordered) | **no**: it reacts to *failures*, not to *volume*; a healthy 50k backlog is never parked |

**Fairness by key in Kafka: nothing built in.** Two kinds of fairness:
- **Throughput share**: a heavy tenant can't take all the workers. Achievable: Parallel Consumer in `KEY` mode runs at most one record per key at a time, so a hot key can't occupy more than one thread; or a consumer-side per-tenant concurrency/rate limit (token bucket per tenant).
- **Latency isolation**: a small tenant's message doesn't wait behind a heavy tenant's backlog. **This is the hard one**: a partition is fetched in offset order, so if 50,000 heavy-tenant records sit ahead of one small-tenant record, the consumer can only process the small one once it has fetched that far. Parallel processing helps only within its look-ahead buffer.
**Why none of the add-ons fix the noisy neighbour:** they solve *failure* isolation (a broken key stops only itself). A 50k backlog from a healthy account is a *volume* problem: in a log, **position = priority**, so the small account's message is behind the 50k no matter how cleverly you process. Fairness needs picking work **by tenant**, not by position: a scheduler. With Kafka that means separating heavy traffic *before* it shares a partition, or not using a log for this.
Workarounds, all topology or scheduling you build: **hot-key rerouting** (the producer sends known-heavy or currently-bursting accounts to a separate "bulk" topic with its own consumers; moving a key between topics mid-stream must drain the old topic first to keep order), **dedicated topics for "whale" tenants**, **per-tenant rate limits at ingestion** (throttle or 429 the noisy producer), **priority lanes** (separate topics per tier, consumed with weights), throttle-and-defer (over-budget tenants' messages go to a delay topic; breaks order unless the whole key is parked). Kafka's broker **quotas** limit bytes/s per *client*, not per key, so they don't help with tenant data inside one topic.
Systems where per-key fairness *is* native: **SQS fair queues** (best-effort, unordered), RabbitMQ with a queue per tenant (consumers round-robin across queues), and a **Postgres jobs table** (hard caps per tenant in the claim query; jobs are claimed by condition, not by position, so there's nothing to fetch past).

**Are the Kafka layers "hacks"? No.** They're the documented, production-proven way to add per-key isolation to a partition-based log: Confluent ships Parallel Consumer and documents retry/DLQ topic patterns, Uber runs uForwarder at scale. In an interview this is a strong answer if you **frame the trade-off**:
> "Kafka orders per partition, and a partition holds many accounts, so one stuck account would block its neighbours. At our volume I'd keep ordering in Postgres with a per-account cursor. If we outgrew that, I'd key Kafka by account and add key-level isolation, either a key-ordered parallel consumer or a parking-lot topic with a store of parked accounts, accepting that we then own per-key state in the consumer. If we were on Azure or GCP, sessions or ordering keys give that natively at lower per-key throughput."
What would get pushback: claiming plain consumer groups isolate accounts, or proposing one partition (or topic) per account for thousands of accounts.

### Industry-standard answers for "ordered + isolated" and "ordered + isolated + fair"

**Temporal** (open source, from Uber's Cadence; self-hosted or Temporal Cloud): a **durable execution** engine, not a queue. You write a workflow as ordinary code (TypeScript, Go, Java, Python); the server records every step in its database, so after a crash the workflow continues exactly where it stopped. Built in: retries, timers ("wait 30 days"), and **signals** (events sent to a running workflow). Each workflow has an ID (e.g. `account-77`), and its signals are handled one at a time, in order: per-key serialization out of the box. Cost: a server cluster (plus its DB), low throughput per single workflow, and a different programming model (workflow code must be deterministic).

**The concept:** "ordered + isolated" = **per-key serialization**: at most one in-flight item per key (account), and keys never wait for each other. "Fair" = a **scheduler across keys or tenants**. The standard tools are the ones where per-key serialization is a **first-class concept**, so you don't build it yourself.

**1. Ordered + isolated**
| Context | Standard choice | Why / catch |
|---|---|---|
| Moderate volume (up to thousands/s), money | **Database-backed queue**: per-entity cursor + `SKIP LOCKED` (transactional inbox) | same transaction as business data, per-entity stop, inspectable in SQL; scale by sharding the DB |
| Long, multi-step processes (onboarding, payouts, sagas) | **Workflow engine** (Temporal): one workflow per entity, events sent as signals | ordered, isolated, durable retries and timers, visible state; per-workflow throughput is low (tens of events/s), history size limits (continue-as-new), a cluster to run or pay for |
| Managed broker on AWS | **SQS FIFO**, `MessageGroupId = entity` | per-group order and isolation. Throughput: 300 calls/s per action by default (3,000 msg/s batched), high-throughput mode up to 70,000 calls/s in the biggest regions, but **one in-flight batch per group**. No history: deleted after processing, ≤ 14 days retention; the DLQ skips |
| Managed broker on Azure | **Service Bus sessions**, `SessionId = entity` | session lock, session state, manual dead-lettering, default message TTL unlimited, so a stuck session can genuinely wait |
| Managed broker on GCP | **Pub/Sub ordering keys** | 1 MB/s per key; an unacked key can delay others |
| Very high volume (100k+/s) | **Kafka keyed by entity** + one isolation add-on: a key-level parallel consumer, a consumer proxy (uForwarder) or parking-lot/retry topics | nothing else does this volume with ordering, so at this scale those add-ons *are* the standard practice; you accept owning per-key state |

**2. Ordered + isolated + fair**
Two levels of fairness:
- **Across keys**: every option above already gives it, because per-key serialization means one key can never use more than one worker.
- **Across tenants who own many keys** (a customer with 50k accounts vs one with 20): needs a scheduler with per-tenant weights or caps:
| Option | How | Catch |
|---|---|---|
| **Database-backed queue** | per-tenant cap or round-robin in the claim query (`… AND running_for_tenant < 20`, or order by the tenant's least-recently-served) | the standard at moderate scale; you write ~one query |
| **Temporal task queue fairness** | a **fairness key** per tenant (each gets a virtual queue, dispatched round-robin) + **weights** + priority levels 1–5 | paid in Temporal Cloud; enforced per task-queue partition; accuracy degrades with very many keys |
| SQS | FIFO groups are fair per key; **fair queues** are fair per tenant but **unordered** | no native ordered + fair-by-tenant combination; workaround: a queue per tier |
| Kafka | nothing native | whale topics, priority lanes, consumer-side scheduling |

**Throughput: the law that applies to every ordered queue.** Strict order per key means one item per key at a time, so **one key's throughput ≈ 1 / processing time** (× batch size if you apply several events at once). 10 ms per event ⇒ ~100 events/s for that account, on *any* broker. Brokers differ in **total** throughput across keys, isolation and fairness, never in this. One account faster ⇒ faster processing, batching, or a smaller ordering scope (per lease instead of per account, if events never cross leases).
| Option | Total throughput (rough) | One key / tenant |
|---|---|---|
| **Postgres** per-entity queue | ~1k–few k events/s per DB; shard for more | serial; ~100–500 events/s with ms-level transactions |
| **SQS FIFO** | per queue: 300 calls/s (3,000 msg/s batched) by default; high-throughput mode up to 70,000 calls/s (700k msg/s) in the biggest regions, as SQS adds partitions | a group hashes to **one partition**: max 300 calls/s (3,000 msg/s batched), and in practice one in-flight batch at a time, so ≈ batch size / processing time |
| **Temporal** | per namespace: Temporal Cloud default 500 actions/s (raised on demand); self-hosted depends on its DB | one workflow is serial and limited (10,000 signals, 51,200 history events or 50 MB, then continue-as-new): for business processes, not high-rate streams |
| **RabbitMQ**, queue per tenant | a cluster: 100k+ msg/s spread over many queues; one queue: roughly 10k–50k msg/s (one Erlang process per queue) | ordered only with **one active consumer** per queue (single active consumer), so serial |
| **Kafka** keyed by account | 100k–millions msg/s, scales with partitions | one partition = one leader broker + one consumer, so serial |

**"One queue per key" (key = account/customer): ordered inside the key, no head-of-line blocking across keys, a busy key doesn't slow others.**
Isolation and fairness come from the same fact: an ordered key uses **at most one worker at a time**, so customer A's 100,000-event burst occupies one worker while customer B always gets another one.
**Throughput per key** = min(the broker's per-key ceiling, **batch size / time to process one batch**). The second term is almost always the real limit.
- **Broker ceiling**: what the broker allows for one key. SQS FIFO and Pub/Sub: a hard quota set by the cloud provider. RabbitMQ and Kafka: a physical limit (one queue = one Erlang process on one CPU core; one partition = one leader's disk and network), not a quota.
- **Processing speed**: your code (DB writes, API calls); unrelated to the queue. If it handles 200 events/s, SQS's 3,000 ceiling never matters; a higher broker ceiling only helps if your processing is faster than the lower one.
| Broker (per-key unit) | Isolated + fair across keys | Broker ceiling per key | Latency |
|---|---|---|---|
| **SQS FIFO** (message group) | ✓ | 300 calls/s = **3,000 msg/s** with batches of 10; one in-flight batch per group | ~10–50 ms per call |
| **Google Pub/Sub** (ordering key) | ✓ (an unacked key can delay others) | **1 MB/s** publish per key (~1,000 msg/s of 1 KB); delivery one callback at a time | tens of ms |
| **Azure Service Bus** (session) | ✓ | one receiver per session; no published per-session number | tens of ms |
| **RabbitMQ** (queue + single active consumer) | ✓ | **~10k–50k msg/s** per queue (broker side); prefetch lets the consumer pull batches | **~1 ms** |
| **Postgres** (cursor row) | ✓ | ~200–1,000 events/s with one transaction per event; several thousand/s applying a batch per transaction | ~1 s polling, ms with `LISTEN/NOTIFY` |
| **Temporal** (workflow) | ✓ | low: a workflow isn't built for high-rate events (10,000 signals per run, then continue-as-new) | tens–hundreds of ms |
| **Kafka** (partition) | ✗ (partition shared by many keys) | ~10 MB/s per partition | ms |
Highest per-key ceiling with isolation: **RabbitMQ** (then SQS FIFO at 3,000 msg/s). **Google Pub/Sub** = Google Cloud's managed messaging service (roughly SNS + SQS in one). Azure Service Bus and Temporal aren't bad, just Azure-only / built for long multi-step processes rather than high-rate events. Kafka works only with a dedicated topic per key, fine for a handful of big customers, too heavy for thousands (every partition is files, replication and metadata; consumers subscribe to all of them). Other brokers with per-key groups: **ActiveMQ Artemis message groups** (`JMSXGroupID`), **Pulsar `Key_Shared`**, a **Redis Stream per key**, **NATS JetStream** subjects per key. Example: customer A sends 100,000 events, processing takes 50 ms per batch of 10 → ~200 events/s → A drains in ~8 min; customer B is unaffected throughout.
Faster per key: **batch** (apply several consecutive events in one transaction or call, order kept), make processing faster, or **split the ordering key** (per lease instead of per account, if events never cross leases), so one customer gets parallelism across its leases.

**Fastest option per combination of needs** (total throughput; one key is always ~1 / processing time):
- **Ordered + isolated per key**: **SQS FIFO high-throughput** (managed, up to 700k msg/s per queue in the biggest regions, ≤ 3,000 msg/s per group) or **Kafka** keyed by entity (millions/s, but head-of-line blocking per partition).
- **+ fair, when the fairness unit = the ordering unit** (fair between accounts): every per-key option already is (one account can't use more than one worker); RabbitMQ queue-per-key with round-robin consumers also fits.
- **+ fair per tenant while ordering per account** (a customer with 50k accounts vs one with 20): needs a **two-level scheduler** (order per account, share per tenant). Native only in **Temporal** (workflow per account, fairness key per tenant; scales with what you provision or pay for) and a **Postgres queue** (per-account cursor + per-tenant cap in the claim query; ~1k–few k events/s per DB, shard for more). RabbitMQ queue-per-tenant serializes the whole tenant; queue-per-account loses tenant fairness. Beyond that: Kafka + your own scheduling topology.

**For this kind of role** (AWS, Node, fintech, moderate volume): a Postgres per-account cursor + per-tenant caps; Temporal when the processes are long and multi-step. Interview line:
> "For ordered, isolated and fair processing at our scale, the standard answer is a database-backed queue with per-entity serialization and per-tenant caps, or a workflow engine like Temporal with fairness keys. Managed brokers with native per-key serialization, SQS FIFO groups or Service Bus sessions, cover ordered + isolated. Kafka needs extra layers for that and is worth it only at very high volume."

### "SNS + SQS + an S3 archive" instead of Kafka?
A legitimate AWS pattern: **SNS** fans out to one **SQS** queue per consumer, and a **Firehose** subscription writes every message to **S3** (or use **SNS FIFO archiving & replay**: up to 365 days, a subscriber replays a time window; EventBridge has archive & replay too). It covers fan-out, work queues and history, and is often the right "no Kafka" choice at moderate scale.
What you give up compared with Kafka:
| | Kafka | SNS + SQS + S3 |
|---|---|---|
| New consumer reads history then continues live | one consumer, starts at offset 0, seamlessly reaches live | replay the archive, then switch to a live queue: overlap/gap at the hand-over, needs dedupe |
| Replay | native: reset the offset | a job that reads S3 files and republishes (SNS FIFO: replay a time window) |
| Order in history | per partition, exact | Firehose writes buffered batch files (time/size windows), not a per-key ordered log |
| Archive freshness | immediate | Firehose buffers ~60 s+ before writing |
| Latest state per key | compacted topics | build it yourself |
| Stream processing (joins, windows) | Kafka Streams, Flink | not built in |
| Cost at very high volume | cheap per message | per-request pricing grows linearly |
Rule of thumb: few consumers, replay rare, moderate volume → SNS + SQS (+ archive). Many consumers joining over time, replay as a routine tool, stream processing or 100k+ msg/s → Kafka.

### Use cases and costs side by side (AWS, us-east-1, list prices checked Oct 2026; verify before quoting)

| Service | What it is | Best for | Not for | Pricing model | List price | What drives the bill |
|---|---|---|---|---|---|---|
| **SQS** Standard / FIFO | queue: each message handled by one consumer, then deleted | background jobs, decoupling services, work queues with retries + DLQ; FIFO for per-group order | replay, many independent consumers (add SNS fan-out), billions of tiny events | per **request** (each 64 KB = 1) | $0.40 / $0.50 per 1M; 1M/month free | each message ≈ send + receive + delete = **3 requests**; batch 10 per call |
| **Kinesis Data Streams** | log/stream: records kept 24 h–365 d, ordered per shard, many consumers, replay | high-volume event streams on AWS (clicks, telemetry, CDC) read by several consumers | per-message retries/DLQ, long-running job processing | on-demand: stream-hour + GB; provisioned: shard-hour + PUT units | on-demand $0.04/h, $0.08/GB in, $0.04/GB out; provisioned $0.015/shard-h, $0.014 per 1M PUT units (25 KB) | data volume (on-demand) or shard count (each ~1,000 records/s, 1 MB/s in) |
| **Firehose** | delivery pipe: buffers records and writes batch files | getting events into S3 / Redshift / Snowflake / OpenSearch with zero consumer code | being read by your code (no consumers), per-record processing | per GB in | $0.029/GB (first 500 TB) | **each record rounded up to 5 KB**: pack many events per record |
| **MSK** (managed Kafka) provisioned | log, like Kinesis, open-source API | Kafka ecosystem (Connect, Streams, Debezium), very high throughput, long retention, multi-cloud | small/occasional workloads (fixed floor) | broker-hour + storage | ≈ $0.20/broker-h (m7g.large), $0.10/GB-month | 3+ brokers 24/7: ≈ $450+/month floor |
| **MSK Serverless** | Kafka without sizing brokers | Kafka API at moderate, spiky volume | the cheapest option for tiny volume | cluster-hour + partition-hour + GB | ≈ $0.75/h (≈ $550/month base), $0.0015/partition-h, $0.10/GB in | the fixed cluster-hour |
| **Amazon MQ** (RabbitMQ) | classic broker: routing (exchanges, topics), acks, priorities | complex routing, AMQP/MQTT clients, lifting an existing RabbitMQ app | huge throughput, replay | broker-hour + EBS | mq.m5.large ≈ $0.29/h per node; 3-node ≈ $700/month | always-on instances |
| **Postgres as a queue** (outbox / jobs table + `SKIP LOCKED`) | rows you claim and update | jobs that must commit atomically with business data, moderate volume | very high volume, fan-out to many teams | your existing DB | $0 extra | DB load (vacuum, locks) |

**Shape of the costs:**
- **Per-request services** (SQS, Lambda triggers) are almost free at low volume and expensive for billions of tiny messages.
- **Per-capacity services** (MSK, Amazon MQ, provisioned Kinesis) have a fixed monthly floor, then are cheap per extra message.

Example: 10B click events/month:
- **SQS, one message per click:** ≈ 30B requests ≈ **$12,000/month**.
- **SQS, batched by 10:** ≈ $1,200/month.
- **After in-process pre-aggregation:** a few dollars.
- **Firehose:** one 150 B event per record bills 10B × 5 KB = 50 TB ≈ **$1,450**. The same data packed into ~1 MB records is 1.5 TB ≈ **$44**.

### Choosing: the decision in order
1. **Command or fact?** A fact many services react to (`PaymentCompleted`) → **Kafka** (or SNS → SQS). A command one handler executes ("charge payment 9") → a queue: steps 2–4.
2. **Does order matter?** No → **SQS** (standard, fair queues), unless you need far-ahead scheduling, querying/editing items, hard per-tenant caps or creation in the business transaction → **Postgres table**.
3. **Order matters, and head-of-line blocking per partition is acceptable** (failures rare, a stall may hit neighbours, or you add key-level isolation) and volume is high → **Kafka** keyed by entity.
4. **Order matters and one entity's failure must not block others, or you must wait for gaps in a partner's sequence** → **Postgres** (per-entity cursor). It isn't "slow" at this scale: thousands of events/s against tens/s needed. Move to Kafka (+ key-level isolation) only when volume proves it necessary.
Often combined: **Postgres is the source of truth and does the ordering; SQS/Kafka are transport** (outbox → relay).

This repo uses both: `payments-charge` goes outbox → SQS (independent commands, managed retries); charge retries and resolver checks are Postgres jobs (`jobs.enqueue` with `runAt`), and `claimJobs` enforces per-shop caps.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SqsTaskQueue`](../../packages/backend/libs/infrastructure/sqs/sqs-task-queue.ts#L17): SqsTaskQueue is the SQS adapter used for work queues. _(sqs-task-queue.ts)_
> - [`KafkaProducerService`](../../packages/backend/libs/infrastructure/kafka/kafka-producer.service.ts#L7): KafkaProducerService is the Kafka producer for high-throughput streams. _(kafka-producer.service.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: Fan-out vs competing consumers?**
Competing consumers means N identical workers share one queue and each message is processed once, which is load sharing. Fan-out means each subscribing service gets its own copy of every event, which is broadcast. With SQS you get fan-out through SNS (or EventBridge) feeding one queue per service. Kafka does fan-out across consumer groups (each has its own offsets) and competing consumers inside a group (partitions split among members).

**Q: What's an idempotent producer?**
It handles duplicates caused by producer retries after a lost ack. The broker assigns a producer ID, the producer numbers each batch per partition, and the broker drops sequence numbers it has already written and rejects gaps. You get exactly one copy, in order. It doesn't dedupe your application calling send twice and doesn't survive a restart without a transactional.id, so consumers still need idempotency. SQS FIFO's equivalent is MessageDeduplicationId (5-minute window).

**Q: SQS FIFO message groups vs Kafka partitions?**
Both serialize processing per unit. A FIFO group is whatever ID you choose, usually one per entity, and is handed to any free consumer, so a stuck message blocks only that entity. A Kafka partition is a fixed bucket shared by every key that hashes to it, owned by one consumer per group until a rebalance, so a stuck message blocks all those keys and parallelism is capped by the partition count.

**Q: How do you make sure an event is published whenever the DB changes, and never published if the DB transaction fails?**
Transactional outbox: write the event to an outbox table in the same transaction, and a relay (polling with SKIP LOCKED, or CDC/Debezium) publishes it at-least-once. Consumers are idempotent.

**Q: How do you handle duplicate SQS messages?**
Assume at-least-once delivery. Idempotent consumers: a dedupe table keyed by message or business ID, written in the same transaction as the side effect, or naturally idempotent upserts. Visibility timeout comfortably above processing time, partial batch failures in Lambda, and a DLQ after N attempts.

**Q: How do you preserve ordering per customer with Kafka and still scale?**
Key by customer ID so a customer's events land in one partition, and scale with partition count. Consumers keep per-key processing sequential and guard with version numbers against reordering from retries. Retry topics break ordering, so for strict order, block and retry in place or park the whole key.

**Q: SQS FIFO message keeps failing. What happens?**
It blocks its message group until it succeeds or hits maxReceiveCount and moves to the DLQ. Other groups continue. That's why group IDs should be fine-grained and poison messages should go to the DLQ quickly.
