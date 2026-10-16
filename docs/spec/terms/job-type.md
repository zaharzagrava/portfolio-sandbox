---
id: job-type
title: Job type
kind: term
status: draft
aliases: [type, types]
defined_for: S49-job-scheduler
rules_hash: 318878410ce3
---
# Job type
## Definition
A job type is the name that says what kind of work a job is. A domain registers one [handler](job-handler.md) per type with [`@JobHandler`](job-handler.md). [Enqueue](job-enqueue.md) rejects types that have no registered handler. A worker [claims](job-claim.md) only jobs whose type it has a handler for. A caller-supplied key that stops duplicate jobs is bound to one type, so reusing it with another type fails with [`IdempotencyKeyConflictError`](idempotency-key-conflict-error.md).

## Example
`search.refresh-popularity` and `search.backfill-shop-state` are job types. A worker with no handler for `search.backfill-shop-state` never claims those jobs.

## Known gaps
- The spec does not state naming rules for job types. It states name rules only for schedules, through `InvalidScheduleError`.
- The [handler registry](job-type-registry.md) rules (AS-91 to AS-94) have tests but no rule on the page. For example, the spec does not say what happens when two handlers register the same type.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-45
- [S49](../capabilities/S49-job-scheduler.md): R-05, B-04
- [idempotency-key-conflict-error](idempotency-key-conflict-error.md)
- [job-claim](job-claim.md)
- [job-enqueue-key](job-enqueue-key.md)
- [job-enqueue](job-enqueue.md)
- [job-handler](job-handler.md)
- [job-payload-contract](job-payload-contract.md)
- [job-type-registry](job-type-registry.md)
- [job](job.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
<!-- used-by:end -->
