---
id: job-enqueue-key
title: Job enqueue key
kind: term
status: draft
aliases: [dedup key, key]
defined_for: S49-job-scheduler
rules_hash: 19f974e73f0b
---
# Job enqueue key
## Definition
The enqueue key is the optional [`idempotencyKey` ↗](../sw-external-terms.md#idempotency) a caller passes to [`JobsService.enqueue`](job-enqueue.md) so that the same job is created only once. A repeat enqueue with the same key creates nothing and returns the original id with [`created: false`](enqueue-created-flag.md). Reusing the key with a different [job type](job-type.md) fails with [`IdempotencyKeyConflictError`](idempotency-key-conflict-error.md). The key is stored in the caller's transaction, so it exists only if the caller commits. It stays reserved for a time after its job finishes, then becomes free again.

## Example
```
tx: enqueue(type, payload, { idempotencyKey: "K" }) → rollback
later: enqueue(type, payload, { idempotencyKey: "K" }) → { id, created: true }
```
[Cron fires](cron-schedule-materialisation.md) use generated keys such as `cron:s:2026-10-07T07:00:00.000Z` (S49.B-02, S49.B-15).

## Known gaps
- The spec does not say whether a key is unique across the whole system or only within one shop.
- Not confirmed in the code: the enqueue code and the idempotency-key table are not listed. The key expiry is only known to run in the daily [`jobs.partition-maintenance`](jobs-partition-maintenance.md) schedule.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): B-02
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [dedupe-period](dedupe-period.md)
- [job-cancel](job-cancel.md)
- [job-type](job-type.md)
- [jobs-partition-maintenance](jobs-partition-maintenance.md)
- [notifications-wake-delivery-job](notifications-wake-delivery-job.md)
<!-- used-by:end -->
