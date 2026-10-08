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
| Throughput | nearly unlimited | 300 msg/s per API action (3,000 with batching); **high-throughput mode** much higher (scales per message group) |
| Ordering | best-effort | strict **per `MessageGroupId`** |
| Duplicates | possible (at-least-once) | dedup within **5-minute** window via `MessageDeduplicationId` or content-based |

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
