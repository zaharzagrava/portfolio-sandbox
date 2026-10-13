---
id: job-attempt
title: Job attempt
kind: term
status: draft
aliases: [attempt, attempts]
defined_for: job-scheduler-lease
rules_hash: 54b210905732
---
# Job attempt
## Definition
An attempt is one try at running a job, by one worker, under one [lease](job-lease.md). Attempts are numbered, and the job keeps a count of them (`attempts`). After a thrown error, the count sets the [backoff delay](job-retries.md) before the next try. Reaching [`maxAttempts`](job-max-attempts.md) makes the job [`DEAD`](job-status.md) instead of re-queued. Writes for the job are accepted only when they carry both the current attempt number and the worker running that attempt.

## Example
After a job's 3rd attempt throws, the retry delay is a random value between 0 and `min(15 min, 1 s × 2^3)` = 8 s. The count of 3 is illustrative. Picking a random value from that range is full [jitter](jitter).

## Known gaps
- Not confirmed in the code: exactly when `attempts` goes up, for example at claim time or when the attempt ends. The spec only says [the reaper](job-reaper.md) must not change it.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-15
- [S14](../capabilities/S14-ledger-reconciliation.md): B-13
- [S28](../capabilities/S28-notifications.md): R-31
- [S49](../capabilities/S49-job-scheduler.md): R-11, B-11
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-04
- [attempt-fencing](attempt-fencing.md)
- [failover-timeline-entry](failover-timeline-entry.md)
- [fallback-provider](fallback-provider.md)
- [job-due](job-due.md)
- [job-lease](job-lease.md)
- [job-max-attempts](job-max-attempts.md)
- [job-payload-contract](job-payload-contract.md)
- [job-reaper](job-reaper.md)
- [job-retries](job-retries.md)
- [job-retry-outcome](job-retry-outcome.md)
- [ledger-ensure-partitions](ledger-ensure-partitions.md)
- [mail-provider](mail-provider.md)
- [provider-timeout](provider-timeout.md)
- [provider-unavailable-failed-run](provider-unavailable-failed-run.md)
- [send-budget](send-budget.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
- [transient-error](transient-error.md)
- [transient-failure](transient-failure.md)
<!-- used-by:end -->
