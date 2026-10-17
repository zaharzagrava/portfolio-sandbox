# Data Model: S55 — Lambda workers

No Postgres table. The only store owned is the DynamoDB table `Idempotency`.

## Idempotency record (table `Idempotency`)

| Field | Type | Rule |
|---|---|---|
| `PK` | string, hash key | `<function>#<key>`; key 1–512 characters, no control characters, no empty part (FR-026) |
| `status` | `IN_PROGRESS` \| `COMPLETED` | A record without `status` is a live conflict, never a success |
| `ownerToken` | string (random per attempt) | Completion and release are conditional on it (FR-023) |
| `leaseUntil` | epoch ms | At least the function timeout, positive (FR-028); expired lease ⇒ claimable |
| `fingerprint` | string, optional | Mismatch ⇒ `IdempotencyKeyConflictError` (FR-025) |
| `result` | JSON string, optional | Absent when `resultOmitted` |
| `resultOmitted` | boolean | Set when the serialised result exceeds 64 KiB (FR-027) |
| `completedAt` | epoch ms | Set on completion |
| `expiresAtEpoch` | epoch s, TTL | Retention, default 24 h; a record past it counts as absent although the store deletes lazily (FR-021) |

State transitions: none → `IN_PROGRESS` (conditional claim) → `COMPLETED` (token match) ; `IN_PROGRESS` → deleted (failure release, token match) ; expired lease or expired retention → replaced by a new claim. A holder whose token no longer matches gets `StaleClaimError` and changes nothing.

## Manifest entry (`LambdaSpec`)

`name`, `entry`, `queue`, `fifo`, `timeoutSec`, `memoryMb`, `batchSize`, `maxConcurrency`, `visibilityTimeoutSec`, `maxReceiveCount`, `dbPoolMax` (default 2), `deadLetter?: { entry, batchSize, maxConcurrency }`. The build expands `deadLetter` into a second function `<name>-dlq` on `<queue>-dlq` (FIFO: `<base>-dlq.fifo`) with the same rules. Validation rules: [contracts/manifest.md](contracts/manifest.md).

## Task message / batch response

`TaskMessage<T> = { id, body, receiveCount, attributes }` (S53). `SqsRecord` gains `messageAttributes`, `eventSource`, `awsRegion`, `md5OfBody`, `MessageDeduplicationId`, `SequenceNumber`. Response: `{ batchItemFailures: { itemIdentifier }[] }`.

## Queue configuration (three copies, one source)

Manifest → must equal `infra/docker/elasticmq/elasticmq.conf` and the `queues` map in `infra/stack/main.tf` on visibility, receive limit, FIFO flag and DLQ name.
