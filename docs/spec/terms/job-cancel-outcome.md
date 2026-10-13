---
id: job-cancel-outcome
title: Job cancel outcome
kind: term
status: draft
aliases: [cancelled, conflict, not_found]
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# Job cancel outcome
## Definition
The job cancel outcome is the result that [`JobsService.cancel`](job-cancel.md), `cancelByKey` and the admin `cancel` return when someone tries to cancel a job. Only a [`QUEUED`](job-status.md) job can be cancelled, and that returns `CANCELLED`. A job in any other status returns `CONFLICT`, along with its current status. An unknown id, or a job that belongs to [another shop](shop-tenant.md), returns `NOT_FOUND`. Cancel and [job claim](job-claim.md) are [mutually exclusive ↗](../sw-external-terms.md#mutual-exclusion), so a job is either cancelled or run, never both.

## Example
```
cancel(<id of a RUNNING job>)   → CONFLICT, status RUNNING
cancel(<id of a QUEUED job>)    → CANCELLED
cancel(<other shop's job id>)   → NOT_FOUND
```

## Known gaps
- The spec does not say the exact shape of the returned outcome object.
- The spec does not say how the caller's shop is determined for the `NOT_FOUND` check. Hiding other shops' jobs is design intent (not stated in the spec).
- The spec does not say what `cancelByKey` returns when the idempotency key matches no job.

## Used by
<!-- used-by:start -->
- [job-claim](job-claim.md)
- [shop-tenant](shop-tenant.md)
<!-- used-by:end -->
