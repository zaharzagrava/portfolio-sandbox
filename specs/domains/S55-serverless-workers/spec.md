# Feature Specification: S55 — Lambda workers: partial batch failures, idempotency records, FIFO groups, local runner (domain `infrastructure`)

**Feature Directory**: `specs/domains/S55-serverless-workers`

**Created**: 2026-10-06

**Status**: Draft

**Input**: Capability S55 of `scripts/sdd/capabilities.tsv`: "Lambda workers: partial batch failures, idempotency records, FIFO groups, local runner". Sources: `docs/showcase/sections/SD-03-serverless-lambdas.md`, `interview-prep/06-distributed-systems/01-messaging-queues-kafka-sqs.md` §3 (SQS deep dive). Pattern rows owned here: P0107 (ESM vs CJS bundling), P0604 (SQS standard vs FIFO, group IDs, dedup IDs, visibility, DLQ and redrive, partial batch failures), P0706 (trace propagation across SQS), P0809 (AWS service choices: Lambda, SQS, RDS Proxy, DynamoDB, IAM, cost).

## Scope

In scope: the serverless worker toolkit that every queue-fed function uses, and the way functions are declared, bundled, run locally and wired to their queues.

- Reporting which records of a batch failed (and only those), for standard and FIFO queues.
- Idempotency records that turn at-least-once delivery into exactly-once effects.
- FIFO message-group behaviour on the consumer side: order inside a group, independence between groups, a poison message blocking only its group, what happens when it is dead-lettered.
- Queue configuration that a function depends on (visibility timeout, receive limit, dead-letter queue, redrive) and its single source of truth.
- Dead-letter handlers and redrive.
- Cached application context for functions that need domain services, and small functions that do not.
- Logs, metrics and trace propagation of an invocation.
- Bundling of one deployable per function.
- The local runner that stands in for the Lambda service and the SQS event source.

Out of scope, owned elsewhere (this spec only states what it requires from them):

- The task-queue port used by producers and by long-running worker consumers (enqueue, FIFO group and dedupe ID, validation of options) → **S53**.
- The outbox, the event envelope and the `traceparent` format → **S53**.
- The business behaviour of each function: webhook delivery → **S43**; photo processing → **S29**; KYC document extraction and the review queue → **S04**.
- HTTP idempotency keys (the Postgres table in the IX.3 allowlist) → **S54** and **S10**. The records here live in a separate key-value store and are not that table.
- The LLM provider port → **S46** (debt D-14).
- Terraform itself → ops (O-03). This spec states the properties the deployment must have and how they are checked.

Actors: **a domain developer** (adds a function, writes its handler), **an operator** (watches dead-letter queues, redrives, reads dashboards), **the queue service** (delivers at-least-once, hides messages for the visibility timeout, enforces the group lock), **another container** of the same function (runs concurrently), **the local runner** (stands in for the platform on a laptop and in tests).

No screen exists for this capability. Every scenario is proven below the UI.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A bad record does not redo the good ones (Priority: P1)

A function receives a batch of up to ten messages. One of them fails. The platform must redeliver only that one; the other nine, which already had their effect, must not run again. On a FIFO queue a failure must also stop the later messages of the same group from running, so the group's order is kept, while other groups continue.

**Why this priority**: without it every transient error multiplies side effects (duplicate webhooks, duplicate model calls that cost money) and every poison message stalls a whole batch.

**Independent Test**: call the batch helper with a fake handler that fails chosen records, and assert the returned failure list and which records ran.

**Acceptance Scenarios**:

1. **AS-01 (only the failed record is reported, standard queue)** — **Given** a standard-queue batch of records `a`, `b`, `c` and a handler that throws for `b`, **When** the batch is processed, **Then** the response is `{ batchItemFailures: [{ itemIdentifier: 'b' }] }` and the handler ran exactly once for each of `a`, `b`, `c`.
2. **AS-02 (boundaries of the response)** — **Given** (a) a batch where every record succeeds, (b) a batch of three where every record fails, (c) a batch with no records, **When** each is processed, **Then** the responses are (a) `{ batchItemFailures: [] }`, (b) the three message IDs in the order they arrived, (c) `{ batchItemFailures: [] }` with zero handler calls.
3. **AS-03 (FIFO: a failure fails the rest of its group without running it)** — **Given** a FIFO batch in this order: `a1`(group A), `a2`(A), `b1`(B), `a3`(A), and a handler that throws for `a2`, **When** the batch is processed, **Then** the handler ran for `a1`, `a2`, `b1` only, and the response lists exactly `a2` and `a3` in that order.
4. **AS-04 (FIFO: groups are independent, a group is sequential)** — **Given** a FIFO batch with groups A (`a1`, `a2`) and B (`b1`) where `a1` stays pending until released, **When** the batch starts, **Then** `b1` runs while `a1` is still pending, `a2` has not started, and after `a1` completes `a2` starts; at no moment do two records of one group run at the same time.
5. **AS-05 (standard: bounded concurrency)** — **Given** five standard-queue records and a concurrency limit of 2, **When** the batch is processed, **Then** never more than two handler calls are in flight and all five run.
6. **AS-06 (poison payload: no side effect)** — **Given** a batch where record `b` has a body that is not valid JSON and record `c` has valid JSON that fails the handler's declared body schema, **When** the batch is processed, **Then** the business handler is not called for `b` or `c`, both are reported as failed, the other records are processed normally, and the log lines for `b` and `c` name the message ID and the failure class and contain no part of the body.
7. **AS-07 (any thrown value is a failure)** — **Given** a handler that throws an `Error`, a string, `undefined`, and rejects with `null` for four different records, **When** the batch is processed, **Then** all four are reported failed and none escapes as an exception of the invocation.
8. **AS-08 (deadline margin)** — **Given** an invocation whose remaining time drops below the configured margin after the first record of a four-record standard batch with concurrency 1, **When** the batch continues, **Then** records not yet started are not started and are reported failed, the started record's outcome is reported as usual, and the response is returned before the platform timeout. **And** for a FIFO batch the unstarted records of a group are reported failed in their original order.
9. **AS-09 (batch invariants, any failure pattern)** — **Given** any batch (random size 0–10, random groups, random failing records, standard or FIFO), **When** it is processed, **Then** (a) every reported ID is an input ID, appears once, and the list follows input order; (b) a record that did not fail and was not skipped is not in the list; (c) on FIFO, for each group the records that ran are a prefix of the group's records in input order, and the failed set of the group is exactly the failed record plus every later record of that group.
10. **AS-10 (last attempt is visible)** — **Given** a function whose queue allows 5 receives and a record delivered with receive count 5 that fails, **When** the batch is processed, **Then** the invocation emits the metric `DeadLettered` (count 1, dimensions function and queue) and an error log saying the record will be dead-lettered; **and** on a FIFO queue it also emits `FifoGroupOrderBroken` for that group, since the group continues without this message. A record failing at receive count 4 emits neither.
11. **AS-11 (failure logs are safe)** — **Given** a failing record whose body contains an access token and a customer email, **When** the failure is logged, **Then** the log line carries message ID, function, queue, receive count, error class and message, and carries neither the body nor any message attribute value except the trace ID.
12. **AS-12 (invocation-level failure)** — **Given** a function whose cached application context cannot initialise, **When** an invocation arrives with a batch of three, **Then** the invocation itself fails (no partial response), no record handler ran, and the whole batch becomes visible again after the visibility timeout.

---

### User Story 2 - Exactly-once effects on top of at-least-once delivery (Priority: P1)

The queue delivers a message twice, or two containers receive the same message at the same time, or a container crashes after doing the work. The business effect (a thumbnail written, a model called and paid for, a webhook sent) must happen once. Idempotency records keep one entry per business key: claimed, then completed, with an expiry.

**Why this priority**: duplicate delivery is a normal operating condition, not an error, and some effects cost money or leak to third parties.

**Independent Test**: run the idempotency facility against a real key-value store with a conditional write, with a frozen clock, and drive each case below.

**Acceptance Scenarios**:

1. **AS-13 (claim, run, complete)** — **Given** no record for key `k` of function `f`, **When** work runs through the facility with a lease of 120 s at time T, **Then** before the work returns the record is `IN_PROGRESS` with a lease ending at T+120 s and an owner token; after it returns the record is `COMPLETED` with the work's result, the same owner token, and an expiry at T + retention (default 24 h).
2. **AS-14 (replay)** — **Given** a `COMPLETED` record for `k`, **When** the same key is delivered again, **Then** the work does not run, the stored result is returned with `replayed: true`, and the record is unchanged.
3. **AS-15 (concurrent delivery)** — **Given** no record for `k`, **When** two deliveries of `k` run at the same moment (`Promise.all`), **Then** exactly one runs the work, the other receives `AlreadyInProgressError` without running it, and exactly one record exists.
4. **AS-16 (failure releases the claim)** — **Given** work that throws, **When** it fails, **Then** the record is removed (only if it still carries this attempt's owner token), the error propagates, and a retry of `k` runs the work again.
5. **AS-17 (crashed attempt, stale holder)** — **Given** an attempt A claimed `k` with a 50 ms lease and never finished, **When** the lease passes and attempt B claims and completes `k`, **Then** B's result is stored; **and when** A later finishes, A's completion and A's failure-release are both rejected because A's owner token no longer matches, the record still holds B's result, and A reports `StaleClaimError` to its caller.
6. **AS-18 (expired record is absent)** — **Given** a `COMPLETED` record whose expiry is in the past but which the store has not yet deleted (expiry deletion is lazy), **When** `k` is delivered, **Then** the work runs as a first delivery and the record is replaced.
7. **AS-19 (same key, different payload)** — **Given** a `COMPLETED` or `IN_PROGRESS` record for `k` with fingerprint `F1`, **When** `k` arrives with fingerprint `F2`, **Then** `IdempotencyKeyConflictError` is thrown (classified permanent), the work does not run, and the record is unchanged. With no fingerprint supplied on either side, the check is skipped.
8. **AS-20 (namespaces and tenants)** — **Given** key `k` completed under function `f1`, **When** `k` is delivered to function `f2`, **Then** `f2` runs it (records are per function). **And given** keys built for shop S1 and shop S2 from the same document ID, **Then** they are different keys, so one tenant's completed record never replays for the other.
9. **AS-21 (key validation)** — **Given** an empty key, a key of 513 characters, a key containing a control character, and a key part that is empty, **When** each is used, **Then** each is rejected with `InvalidIdempotencyKeyError` before any store call.
10. **AS-22 (large result)** — **Given** work whose serialised result is 64 KiB + 1 byte, **When** it completes, **Then** the record is `COMPLETED` with `resultOmitted: true` and no result, and a replay returns `{ replayed: true, resultOmitted: true, result: undefined }` without running the work. A result of exactly 64 KiB is stored and replayed in full.
11. **AS-23 (completion write fails after the work succeeded)** — **Given** work that succeeded but whose completion write fails once, **When** the failure surfaces, **Then** the claim is **not** released, the caller sees the store error, `IdempotencyCompletionFailed` is emitted, a redelivery inside the lease gets `AlreadyInProgressError`, and a redelivery after the lease runs the work again (documented at-least-once edge; handlers with irreversible effects must also be naturally idempotent).
12. **AS-24 (store unavailable)** — **Given** the claim write fails with a throttling or network error, **When** a record is processed, **Then** the work does not run, the error is classified transient, and the record is reported failed so the queue redelivers it.
13. **AS-25 (lease validation)** — **Given** a lease of 0, a negative lease, or a lease shorter than the function's configured timeout, **When** the facility is used, **Then** it is rejected before any store call (a lease shorter than the function timeout lets a second container start while the first is still running).
14. **AS-26 (duplicate delivery of one message, through a handler)** — **Given** a function handler guarded by an idempotency record whose effect is writing a row, **When** the same SQS message (same message ID, receive count 1 then 2) is delivered twice in sequence, **Then** one effect row exists, the second invocation reports no failure, and the record is `COMPLETED`.
15. **AS-27 (replay after the producer dedupe window)** — **Given** two messages with different message IDs and different dedupe IDs that carry the same business key (a producer re-send after the 5-minute window), **When** both are delivered, **Then** one effect exists and both messages are acknowledged.

---

### User Story 3 - FIFO groups, queue limits, dead letters and redrive (Priority: P2)

An operator needs to trust the queue side of a function: the visibility timeout is long enough that a slow invocation is not duplicated, a poison message ends in a dead-letter queue instead of looping, only its own group waits meanwhile, and after the cause is fixed the messages can be moved back.

**Why this priority**: these settings decide whether the P1 mechanisms are ever exercised in anger; a wrong visibility timeout silently creates duplicates.

**Independent Test**: validate the manifest and the queue configuration files with table-driven rules; then drive a real FIFO queue and dead-letter queue (local SQS stand-in) through the local runner.

**Acceptance Scenarios**:

1. **AS-28 (visibility ≥ 6 × timeout)** — **Given** a manifest entry with timeout 30 s, **When** its visibility timeout is 179 s, **Then** validation fails naming the function and both numbers; at 180 s it passes. The rule applies to every entry, including dead-letter handlers.
2. **AS-29 (one source of truth)** — **Given** the manifest, the local queue configuration and the Terraform queue map, **When** they are compared, **Then** for every Lambda-consumed queue the visibility timeout, receive limit, FIFO flag and dead-letter queue name are identical in all three; a mismatch is reported with the file and the field. A Lambda-consumed queue that is missing from either file fails the check.
3. **AS-30 (manifest rules)** — **Given** manifest entries that violate one rule each, **When** validated, **Then** each is rejected: a FIFO flag without the `.fifo` suffix (or the reverse); a FIFO batch size above 10; a maximum concurrency below 2 (the platform minimum); a timeout above 900 s or memory outside 128–10,240 MB; two functions on one queue; a receive limit below 1; a dead-letter handler whose queue is not the dead-letter queue of an existing entry; and a set of functions whose `maxConcurrency × dbPoolMax` summed exceeds the declared database connection budget.
4. **AS-31 (FIFO enqueue semantics as seen by the consumer)** — **Given** a FIFO queue, **When** two messages with the same dedupe ID are enqueued within the window, **Then** exactly one is delivered; **and** messages of one group are delivered in send order and a second batch of that group is not handed out while the first is in flight; messages of different groups are delivered to concurrent invocations.
5. **AS-32 (a poison message blocks only its group, then the group continues)** — **Given** a FIFO queue with receive limit 3, group A holding `a1` (always fails) then `a2`, and group B holding `b1`, **When** the runner processes the queue, **Then** `b1` is processed at once; `a2` is not processed while `a1` is retried; after the third failed receive `a1` is in the dead-letter queue and `a2` is then processed; `FifoGroupOrderBroken` was emitted once for group A.
6. **AS-33 (dead-letter landing)** — **Given** a standard queue with receive limit 3 and a record that always fails, **When** it has been received three times, **Then** it is no longer in the source queue and is in the dead-letter queue with its body, group ID (FIFO) and message attributes unchanged, and the invocation count for it was exactly 3.
7. **AS-34 (dead-letter handler)** — **Given** the manifest entry for `onboarding-documents` declares a dead-letter handler, **When** a message `{ documentId: D }` sits in `onboarding-documents-dlq`, **Then** the handler calls the KYC capability's `routeToReview(D, 'retries_exhausted')` exactly once, the message is deleted from the dead-letter queue, and the document is observable in the review queue (S04's state).
8. **AS-35 (dead-letter handler failure and duplicates)** — **Given** the same setup, **When** `routeToReview` throws, **Then** the message stays in the dead-letter queue (it is not lost), is retried after the visibility timeout, and `DeadLetterHandlerFailed` is emitted; **and when** the message is delivered twice after a success, **Then** `routeToReview` has run once (idempotency record keyed by the dead-letter message's business key).
9. **AS-36 (redrive)** — **Given** three messages in a dead-letter queue (one with a FIFO group), **When** the operator runs the runner's redrive command for that queue, **Then** the three messages are back in the source queue with the same body, group ID and attributes (FIFO messages with a fresh dedupe ID), the dead-letter queue is empty, the command prints the count moved, and the messages are processed by the function; redriving an empty queue moves 0 and exits successfully.
10. **AS-37 (deployment properties)** — **Given** the Terraform for Lambda workers and queues, **When** it is statically checked, **Then**: every event source mapping reports batch item failures and has a maximum concurrency from the manifest (at least 2); each function has its own execution role limited to its own queue, its own dead-letter queue (only the dead-letter handler's role may receive from it), the idempotency table and its secrets; each dead-letter queue has a depth alarm (`> 0` for 1 minute) and each Lambda-consumed queue has an oldest-message-age alarm; dead-letter retention is 14 days; the dead-letter queue allows redrive only from its source queue.

---

### User Story 4 - A local runner that behaves like the platform (Priority: P2)

A developer runs the workers on a laptop and in the test stack. The runner must behave like the Lambda service with an SQS event source: the same event shape, the same batch size and concurrency limits, the same retry, delete and timeout behaviour, and it must refuse to run with a configuration that the real platform would turn into duplicates.

**Why this priority**: behaviour proven locally is only worth something if it is the behaviour of production.

**Independent Test**: start the runner against the local queue service with a fixture function and observe the events it passes and the queue state afterwards.

**Acceptance Scenarios**:

1. **AS-38 (event shape)** — **Given** a message sent with a body, a FIFO group ID, a dedupe ID and message attributes (including `traceparent`), **When** the runner invokes the function, **Then** each record has `messageId`, `receiptHandle`, `body`, `attributes` (`ApproximateReceiveCount`, `SentTimestamp`, `SenderId`, `ApproximateFirstReceiveTimestamp`, and for FIFO `MessageGroupId`, `MessageDeduplicationId`, `SequenceNumber`), `messageAttributes` (each with `stringValue` and `dataType`), `md5OfBody`, `eventSource: 'aws:sqs'`, `eventSourceARN` (ending `.fifo` for FIFO queues) and `awsRegion`; records appear in receive order.
2. **AS-39 (delete only what succeeded)** — **Given** a batch of three where the function reports the second as failed, **When** the invocation returns, **Then** the first and third are deleted, the second becomes visible again after the queue's visibility timeout with receive count 2, and the runner did not extend its visibility.
3. **AS-40 (invocation failure and timeout)** — **Given** a function that throws, and another that does not return within its timeout, **When** each is invoked with a batch of three, **Then** none of the records is deleted, all three are received again after the visibility timeout, the runner logs the failure or `timed out after <n>s`, and an abandoned execution is logged as `abandoned_invocation`.
4. **AS-41 (batch size and concurrency)** — **Given** a function with batch size 5 and a local concurrency cap of 2, and 20 messages in a standard queue, **When** the runner processes them, **Then** no invocation has more than 5 records, at most 2 invocations run at the same time, and all 20 messages are processed once. The effective cap is the smaller of the manifest's `maxConcurrency` and the cap in the runner's environment.
5. **AS-42 (fail fast at startup)** — **Given** (a) a queue whose visibility timeout is below 6 × the function timeout, (b) a manifest entry whose queue does not exist, (c) a manifest entry without a bundle, (d) a name on the command line that is not in the manifest, **When** the runner starts, **Then** it prints the offending function and reason, exits non-zero, and has received no messages from any queue.
6. **AS-43 (graceful shutdown)** — **Given** an invocation in flight, **When** the runner receives a termination signal, **Then** it makes no further receive call, waits for the in-flight invocation (bounded by the function timeout), deletes the records that succeeded, and exits with code 0.
7. **AS-44 (delete failures are visible)** — **Given** a delete call that reports failed entries, **When** the runner processes the result, **Then** each failed entry is logged with message ID and code, the runner continues, and those messages are redelivered later (at-least-once; the function's idempotency absorbs it).
8. **AS-45 (broker outage)** — **Given** the queue service becomes unreachable while the runner is polling, **When** receive calls fail, **Then** the runner retries with capped exponential backoff (1 s doubling to 30 s), keeps the process alive, logs each failure once per backoff step, and resumes processing without restart when the service returns.

---

### User Story 5 - Two handler styles, one bundle per function, observable invocations (Priority: P3)

A developer adds a function either as a small plain handler (no Nest) or as a handler that boots a cached application context to reuse domain services. Each function is shipped as its own small bundle. Every invocation emits structured logs, metrics and a trace linked to the producer.

**Why this priority**: cold start, bundle size and observability decide the cost and operability of a serverless worker, but nothing here changes correctness.

**Independent Test**: build all bundles and inspect them; boot the cached context with a fixture module; run a message with a trace context through the runner.

**Acceptance Scenarios**:

1. **AS-46 (context created once)** — **Given** a fixture application module with a provider whose initialisation counts calls, **When** three invocations arrive, two of them concurrently as the first calls, **Then** the module initialised once and all three invocations used the same context.
2. **AS-47 (failed initialisation is not cached)** — **Given** the first initialisation fails and the next would succeed, **When** two invocations arrive one after the other, **Then** the first fails (AS-12), the second initialises again and succeeds, and a failure of one module does not affect the cached context of another.
3. **AS-48 (one bundle per function, CommonJS, handler resolves)** — **Given** the build is run, **When** it finishes, **Then** for every manifest entry (including dead-letter handlers) there is exactly one bundle in CommonJS format whose exported `handler` is a function, no bundle uses top-level `await`, and the plain handler's bundle contains no Nest module.
4. **AS-49 (no duplicated singletons, SDK external)** — **Given** the built bundles, **When** their source maps are inspected, **Then** each Nest bundle contains exactly one copy each of the DI core, the metadata polyfill and the validation library (a second copy breaks DI and `instanceof`), the AWS SDK clients are not inside any bundle, and every bundle is below the platform's package-size limit.
5. **AS-50 (trace continues across the queue)** — **Given** a producer that enqueues a message while a span is active, **When** the function processes it, **Then** the invocation's span has the producer's trace ID and the producer's span as parent, and every log line of that invocation carries the trace ID and the message ID.
6. **AS-51 (metrics line is valid and bounded)** — **Given** a metric emitted with a name, unit and up to three dimensions, **When** it is written, **Then** the line is a valid embedded-metric-format record whose `Dimensions` list exactly the given keys; **and** a call with more than three dimensions, a non-finite value, or an unknown unit writes nothing to the metric stream, logs a warning, and never throws into the handler.
7. **AS-52 (manifest output is what the runner and Terraform read)** — **Given** the build is run, **When** it finishes, **Then** `manifest.json` next to the bundles equals the manifest (every field: name, entry, queue, FIFO flag, timeout, memory, batch size, maximum concurrency, visibility timeout, receive limit, dead-letter handler, `dbPoolMax`), and the runner starts functions from that file and those bundles, not from source.

### Edge Cases

- A batch mixes records of several FIFO groups and a standard-queue ARN is never mixed with a FIFO ARN in one event; a FIFO record without a group ID is treated as one shared group (order kept, nothing runs past a failure) — AS-03, AS-09.
- Invocation ends while records are still running (platform timeout) → the platform redelivers the whole batch; handlers and idempotency absorb it — AS-17, AS-40.
- Two containers receive the same message (visibility timeout expired during a slow run) → one runs, one retries later — AS-15.
- A crashed claim and a late finisher — AS-17.
- Retention expiry lag in the store — AS-18.
- Same key, different body — AS-19; cross-function and cross-tenant keys — AS-20.
- Oversize keys and results — AS-21, AS-22.
- Failure of the store on either write — AS-23, AS-24.
- Visibility shorter than the function timeout — AS-28, AS-42.
- Dead-lettered FIFO message breaks the order of its group — AS-10, AS-32; the system alerts instead of pretending otherwise.
- Poison payload that never succeeds — AS-06, AS-33.
- Redrive of FIFO messages after the original dedupe window — AS-36.
- Broker outage in the runner — AS-45.
- Metrics or logging failing must never fail a record — AS-51.

## Requirements *(mandatory)*

### Functional Requirements

**Partial batch failures (P0604)**

- **FR-001**: A function MUST return a response listing only the message IDs of records that failed; records that succeeded MUST NOT be listed. The list MUST contain each failed ID once, in input order, and only IDs from the input (AS-01, AS-02, AS-09).
- **FR-002**: Event source mappings MUST be configured to report batch item failures (AS-37).
- **FR-003**: On a standard queue, records MUST run concurrently up to a limit set per function (default 10) (AS-05).
- **FR-004**: On a FIFO queue, records of one group MUST run one at a time in input order; groups MUST run independently of each other up to the same limit. When a record of a group fails, every later record of that group in the batch MUST be reported failed without running (AS-03, AS-04, AS-09).
- **FR-005**: A record whose body is not valid JSON, or does not satisfy the handler's declared body schema, MUST NOT reach the business handler; it is reported failed and logged as a permanent failure. A handler MAY signal a permanent failure explicitly; permanent and transient failures are counted separately (AS-06, AS-19).
- **FR-006**: Any thrown or rejected value MUST be treated as a failure of that record only; the invocation itself MUST NOT throw because a record failed (AS-07).
- **FR-007**: The batch helper MUST stop starting records when the remaining invocation time falls below a configurable margin (default 5 s) and report the unstarted records failed (AS-08).
- **FR-008**: An invocation-level failure (context cannot initialise) MUST fail the invocation as a whole, with no partial response (AS-12).
- **FR-009**: When a record fails on its last allowed receive, the invocation MUST emit `DeadLettered`, and on a FIFO queue also `FifoGroupOrderBroken`, so operators are alerted before order silently breaks (AS-10).
- **FR-010**: Failure logs MUST include message ID, function, queue, receive count, error class and message, and the trace ID; they MUST NOT include the body or attribute values (AS-11).
- **FR-011**: A function declared against a queue MUST receive each record as a task message with the same shape the task-queue port gives its worker consumers (`id`, parsed `body`, `receiveCount`, `attributes`), so a consumer written once runs both as a worker and as a function (AS-26, requires S53).

**Idempotency records (P0604, P0809)**

- **FR-020**: The facility MUST keep one record per (function, business key) with status `IN_PROGRESS` or `COMPLETED`, an owner token, a lease end, an optional fingerprint, the result, and an expiry (AS-13).
- **FR-021**: Claiming MUST be a single conditional write that succeeds only when no live record exists: a record is not live when it is `IN_PROGRESS` with an expired lease, or its retention expiry has passed (AS-13, AS-15, AS-17, AS-18).
- **FR-022**: A duplicate of a `COMPLETED` live record MUST return the stored result without running (`replayed: true`); a duplicate of an `IN_PROGRESS` live record MUST fail with `AlreadyInProgressError` without running (AS-14, AS-15).
- **FR-023**: Completion and release MUST each be conditional on the owner token; a holder whose lease was taken over MUST fail with `StaleClaimError` and MUST NOT change the record (AS-16, AS-17).
- **FR-024**: If the work fails, the claim MUST be released. If the work succeeded and only the completion write failed, the claim MUST NOT be released (AS-16, AS-23).
- **FR-025**: When a fingerprint is supplied and differs from the record's, the facility MUST throw `IdempotencyKeyConflictError` (permanent) without running (AS-19).
- **FR-026**: Keys MUST be built from non-empty parts, at most 512 characters in total, with no control characters; keys for tenant-owned work MUST include the tenant identifier. Keys MUST come from the business identity of the work, never from a value that changes per delivery (receipt handle, random ID) (AS-20, AS-21, AS-27).
- **FR-027**: Results over 64 KiB MUST NOT be stored; the record completes with `resultOmitted: true` (AS-22).
- **FR-028**: The lease MUST be positive and at least the function's timeout; retention defaults to 24 h and is configurable per function (AS-13, AS-25).
- **FR-029**: Store errors on the claim MUST be classified transient and MUST prevent the work from running (AS-24).
- **FR-030**: Time MUST come from an injectable clock so every lease and expiry case can be tested with a frozen clock (AS-13, AS-17, AS-18).

**FIFO groups, queue configuration, dead letters, redrive (P0604, P0809)**

- **FR-040**: The manifest MUST be the single source of truth for each Lambda-consumed queue: name, FIFO flag, visibility timeout, receive limit, dead-letter queue, and the function's timeout, memory, batch size, maximum concurrency and database pool size. The local queue configuration and the Terraform queue map MUST agree with it, and a static check MUST fail on any difference (AS-29).
- **FR-041**: Visibility timeout MUST be at least 6 × the function timeout for every entry (AS-28, AS-42).
- **FR-042**: The manifest rules of AS-30 MUST be enforced by validation that runs in the build, in the runner at startup, and in CI.
- **FR-043**: FIFO queues MUST have a FIFO dead-letter queue; a failing message blocks only its own group until its receive limit is reached, after which the group continues without it (AS-32).
- **FR-044**: Every Lambda-consumed queue MUST have a dead-letter queue with the manifest's receive limit; a dead-lettered message MUST keep its body, group ID and attributes (AS-33).
- **FR-045**: A manifest entry MAY declare a dead-letter handler. It is a function on the dead-letter queue with the same batch, idempotency and metrics behaviour as any function; a message it cannot handle stays in the dead-letter queue (AS-34, AS-35).
- **FR-046**: Redrive MUST be possible for every dead-letter queue, in the cloud (the redrive allow policy of AS-37) and locally through the runner command, preserving body, group and attributes, and giving FIFO messages a fresh dedupe ID (AS-36).
- **FR-047**: Maximum concurrency of each function MUST come from the manifest and be applied to the event source mapping; the sum over functions of `maxConcurrency × dbPoolMax` MUST NOT exceed the declared database connection budget (AS-30, AS-37).
- **FR-048**: Terraform MUST give each function its own role limited to its own resources, alarm on dead-letter depth and queue age, keep dead letters 14 days, and allow redrive only from the source queue (AS-37).

**Local runner**

- **FR-060**: The runner MUST start each function listed in the built `manifest.json` from its built bundle, long-polling its queue, building the exact record shape of AS-38, and honouring batch size and maximum concurrency (bounded by a local cap) (AS-38, AS-41, AS-52).
- **FR-061**: After an invocation the runner MUST delete exactly the records not reported failed, and nothing when the invocation threw or timed out. It MUST NOT extend visibility and MUST NOT override the queue's visibility timeout (AS-39, AS-40).
- **FR-062**: The runner MUST enforce the function's timeout, log abandoned executions, and report them (AS-40).
- **FR-063**: The runner MUST refuse to start, before receiving anything, when a queue is missing, a bundle is missing, a name is unknown, or the queue's visibility timeout is below 6 × the function timeout (AS-42).
- **FR-064**: On a termination signal the runner MUST stop receiving, finish in-flight invocations (bounded by the function timeout), delete the successes, and exit 0 (AS-43).
- **FR-065**: Delete and receive failures MUST be logged and survived; receive failures use capped exponential backoff from 1 s to 30 s (AS-44, AS-45).
- **FR-066**: The runner MUST provide the redrive command of FR-046 (AS-36).

**Handler styles, bundles, observability (P0107, P0706, P0809)**

- **FR-070**: A function that needs domain services MUST get its application context from a cache that initialises each module once per container, shares the in-flight initialisation among concurrent callers, and never caches a failure (AS-46, AS-47).
- **FR-071**: A plain function MUST NOT import the application framework (AS-48).
- **FR-072**: The build MUST emit one self-contained CommonJS bundle per manifest entry with an exported `handler`, no top-level `await`, source maps, AWS SDK clients left external, a single copy of each singleton library, and a size inside the platform limits (AS-48, AS-49).
- **FR-073**: The build MUST emit `manifest.json` equal to the manifest (AS-52).
- **FR-074**: Function entry files MUST contain wiring only: no business logic, no SQL, no storage adapter code (X.1). Domain behaviour comes from the owning domain's exported module or factory (IX.7 R1).
- **FR-075**: Functions that open database connections MUST create them once per container with a pool of at most `dbPoolMax` (default 2) so that concurrency times pool size is the connection budget (AS-30).
- **FR-076**: Each invocation MUST continue the producer's trace from the `traceparent` message attribute and put the trace ID and message ID on every log line it writes (AS-50).
- **FR-077**: Metrics MUST be written as embedded-metric-format log lines (no metrics API call on the hot path) with at most three dimensions, none of which may be a message or entity ID. Invalid metric calls MUST be dropped with a warning and never fail a record (AS-51).
- **FR-078**: Every function MUST emit at least: processed records, failed records by class (`permanent`, `transient`, `in_progress`), invocation duration, `DeadLettered` and `FifoGroupOrderBroken` (AS-10, AS-51).

### Key Entities

- **Lambda manifest entry**: one function: name, entry, queue (with FIFO flag), timeout, memory, batch size, maximum concurrency, visibility timeout, receive limit, database pool size, optional dead-letter handler. Source of the bundles, the runner and Terraform.
- **Batch response**: the list of failed message IDs returned to the event source.
- **Task message**: a record as the handler sees it: `id`, parsed `body`, `receiveCount`, `attributes` (including trace context).
- **Idempotency record**: (function, business key) → status, owner token, lease end, fingerprint, result or `resultOmitted`, retention expiry. Lives in the key-value store, not in Postgres, so it is outside the IX.3 registry.
- **Dead-letter message**: a message moved to a dead-letter queue after the receive limit, unchanged.
- **Runner invocation**: one batch passed to one function, with its timeout, outcome and deletions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In a batch of 10 records with one failing, the 9 other records have their effect exactly once and are never delivered again (0 repeated effects in the scenario of AS-01 and in the property run of AS-09 over 1,000 generated batches).
- **SC-002**: When the same message is delivered twice, or two containers receive it at once, the business effect happens exactly once in 100% of the scenarios AS-15, AS-26, AS-27.
- **SC-003**: A record that never succeeds ends in the dead-letter queue after exactly the configured number of attempts, and the operator is alerted (dead-letter depth alarm, `DeadLettered` metric) before anyone looks at the queue (AS-10, AS-33, AS-37).
- **SC-004**: A poison message in one FIFO group delays no other group: other groups' messages are processed within one poll interval of the poison message's first failure (AS-32).
- **SC-005**: A message that went to a dead-letter queue can be put back and processed again with one command, with 0 messages lost or altered (AS-36).
- **SC-006**: A function configuration that would create duplicate processing (visibility timeout under 6 × timeout, or a queue file that disagrees with the manifest) never reaches an environment: it fails the build, the CI check and the runner start (AS-28, AS-29, AS-42).
- **SC-007**: The local runner and the platform give the same observable results for the cases of AS-38 to AS-41: record shape, which records are deleted, retry count after a failure.
- **SC-008**: A new function can be added by one manifest entry plus one entry file and is then built, run locally, bounded in concurrency and connections, and alarmed with no other file edited (AS-52).
- **SC-009**: Every record of every invocation can be found in the logs by message ID and trace ID, and no log line contains a message body (AS-11, AS-50).

## Cross-capability contracts

Names below are exact. Code lives in `@app/infrastructure/serverless` unless stated. Infrastructure never imports a domain (X.3, X.5); domains and apps import the lib.

### Provides

- **`processBatch(event: SqsEvent, handle: (record: SqsRecord) => Promise<void>, options?: { concurrency?: number; context?: { getRemainingTimeInMillis(): number }; deadlineMarginMs?: number; onRecord?: hooks }): Promise<SqsBatchResponse>`** — never throws for a record failure; response `{ batchItemFailures: { itemIdentifier: string }[] }` per FR-001 to FR-009. `SqsEvent`, `SqsRecord` (with `messageAttributes`, `eventSource`, `awsRegion`, `md5OfBody`), `SqsBatchResponse` are exported types.
- **`defineSqsHandler<T>({ function: string; bodySchema?: ZodType<T>; concurrency?: number; init?: () => Promise<Ctx>; handle(message: TaskMessage<T>, ctx: Ctx): Promise<void> }): (event: SqsEvent, context: LambdaContext) => Promise<SqsBatchResponse>`** — parses and validates the body, continues the trace, logs, emits metrics, calls `processBatch`. `TaskMessage<T>` is the S53 type `{ id, body, receiveCount, attributes }`. Throw `PermanentError` (never retried usefully) or `TransientError` (retry) from `handle`; any other error is treated as transient.
- **`Idempotency`**: `run<T>(key: string, work: () => Promise<T>, options: { leaseMs: number; fingerprint?: string; retentionSec?: number }): Promise<{ result: T | undefined; replayed: boolean; resultOmitted?: boolean }>`. Errors: `AlreadyInProgressError` (transient), `IdempotencyKeyConflictError` (permanent), `StaleClaimError`, `InvalidIdempotencyKeyError`, `IdempotencyCompletionFailed` (metric, plus the store error). `idempotencyKey(...parts: string[]): string` builds a valid key. Guarantee: at most one concurrent run per live (function, key); a completed live key never re-runs.
- **`nestContext(module: Type<unknown>): Promise<INestApplicationContext>`** — one initialisation per module per container, failures not cached.
- **`log(level, message, fields)`** and **`metric(namespace, name, value, unit, dimensions)`** — safe helpers of FR-077.
- **Manifest**: `LambdaSpec { name; entry; queue; fifo: boolean; timeoutSec; memoryMb; batchSize; maxConcurrency; visibilityTimeoutSec; maxReceiveCount; dbPoolMax; deadLetter?: { entry; batchSize; maxConcurrency } }`, the `LAMBDAS` list, and `validateManifest(specs)`. The build emits `dist/lambda-bundles/manifest.json` (the same fields) for Terraform and the runner.
- **Local runner**: `pnpm start:lambda-local [name...]` and `pnpm start:lambda-local -- --redrive <dlq-name>`; environment `SQS_ENDPOINT`, `SQS_QUEUE_URL_PREFIX`, `LAMBDA_LOCAL_MAX_CONCURRENCY` (default 2).
- **Metrics** (namespace `Marketplace/Lambda`, dimensions `function`, `queue`, and `outcome` where noted): `RecordsProcessed`, `RecordsFailed` (`outcome`: `permanent` | `transient` | `in_progress`), `InvocationMs`, `DeadLettered`, `FifoGroupOrderBroken`, `IdempotencyReplay`, `IdempotencyCompletionFailed`, `DeadLetterHandlerFailed`.
- **Idempotency store schema**: the key-value table `Idempotency` with hash key `PK = <function>#<key>` and attributes `status`, `ownerToken`, `leaseUntil`, `fingerprint`, `result`, `resultOmitted`, `completedAt`, `expiresAtEpoch` (TTL).

### Requires

- **S53** (`@app/infrastructure/sqs`, `events`, `outbox`): the `TaskMessage<T>` shape `{ id: string; body: T; receiveCount: number; attributes: Record<string, string> }`; the producer option name `dedupeId` (renamed from `deduplicationId`); trace context in message attribute `traceparent` in W3C format; `PermanentError` and `TransientError` classes; `OutboxService.appendWithExecutor(executor: { query(sql, params): Promise<unknown> }, events | task)` for plain functions that write through a raw connection.
- **S04** (`@app/domains/seller-onboarding`): `OnboardingExtractionModule` with `ExtractionService.process(documentId: string): Promise<void>` and `ExtractionService.routeToReview(documentId: string, reason: string): Promise<void>`; queue `onboarding-documents` with body `{ documentId: string }` (single-consumer message `onboarding.extract_document` v1); `process` throws `TransientError` for provider outages and `PermanentError` for unprocessable documents, so S55 never imports the assistant domain.
- **S43** (`@app/domains/developer-platform`): a Nest module `WebhooksLambdaModule` that provides a handler object `WebhookDeliveryHandler` with `handle(message: TaskMessage<WebhookDelivery>): Promise<void>` (throws `TransientError` to be retried, `PermanentError` for an unprocessable delivery); FIFO queue `webhook-deliveries.fifo` with group = endpoint ID. S43 no longer exports `WebhookDeliverer` (D-8).
- **S29** (`@app/domains/media`): `createMediaProcessor(deps)` where deps are the raw database executor, transaction runner and object-store adapters; the processor's `process(originalKey: string): Promise<'ready' | 'rejected' | 'skipped'>` (the result is JSON-serialisable and small); events written through `OutboxService.appendWithExecutor`. Queue `media-processing`.
- **S54** (`@app/common/*`): injectable clock `now()`; config validation at start-up (functions fail on init, not on first record, when a required variable is missing).
- **S46** (debt D-14): when the LLM port moves to `libs/infrastructure/llm`, nothing in S55 changes; until then S55 does not import it.
- **Test stack** (`docker-compose.test.yaml`): DynamoDB local and ElasticMQ with FIFO and dead-letter queues, Postgres 18 with migrations.
- **Ops O-03**: Terraform reads `manifest.json` and the manifest rules of FR-040; the ops side keeps the queue map and the Lambda module consistent with AS-29 and AS-37.

Cross-domain data in this capability: none. Functions reach a domain only through that domain's exported module or factory (IX.7 R1, in-process). No function reads or writes another domain's table; the only store S55 owns is the key-value `Idempotency` table (outside Postgres, so outside IX.3).

## Pattern coverage

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0107 ESM vs CJS bundling | FR-071, FR-072, FR-073 | AS-48, AS-49, AS-52 |
| P0604 SQS standard vs FIFO, group IDs, dedup IDs, visibility, DLQ and redrive, partial batch failures | FR-001–FR-011, FR-020–FR-029, FR-040–FR-046 | AS-01–AS-12, AS-13–AS-27, AS-28–AS-36, AS-39 |
| P0706 Tracing across SQS | FR-076 | AS-50 (and AS-38 for the attribute round trip) |
| P0809 AWS service choices (Lambda, SQS, RDS Proxy, DynamoDB, IAM, cost) | FR-047, FR-048, FR-075, FR-028 | AS-30, AS-37, AS-13 |

## Assumptions

- Decisions are tagged in `questions.md` (BREAKING and CONTRACT first). The defaults chosen where the notes were silent:
- The toolkit moves out of `apps/lambdas` into `libs/infrastructure/serverless` (X.1: apps contain only bootstrap, nothing imports from `apps/`); `apps/lambdas` keeps one entry file per function and `apps/lambda-local` is a thin launcher. The runner loads the built bundles and `manifest.json`, so what runs locally is what is deployed.
- Queue configuration is declared once, in the manifest; the local queue file and the Terraform map are verified against it (generation is a later option).
- The extension of visibility during a function run is not emulated locally. Lambda does not do it; the 6 × timeout rule replaces it.
- FIFO groups inside one batch run concurrently with each other (the notes say groups are independent); the previous strictly sequential behaviour is dropped.
- Permanent failures are reported failed like any other and the queue's receive limit moves them to the dead-letter queue; no direct send to the dead-letter queue from the function. On FIFO this blocks the group until the limit (AS-32); the alert (FR-009) is the chosen answer to "pause and alert" in the notes.
- The idempotency lease is at least the function timeout; default retention 24 h; key limit 512 characters; stored result limit 64 KiB; metric dimension limit 3; deadline margin 5 s.
- The database connection budget is a constant declared next to the manifest (default 1,000); the current manifest uses 640 (`200×2 + 100×2 + 20×2`).
- The abandoned handler of a timed-out local invocation cannot be killed in-process; it is logged. This is a known difference from the platform.
- Message size above the queue limit uses the claim-check pattern in the producing capability; not part of this capability.
- Message bodies are untrusted input: they are validated before use and never logged.
- SD-03's earlier "Idempotency table with DynamoDB" and the Lambda canary deployment through CodeDeploy remain as they are in Terraform and are not re-specified.
