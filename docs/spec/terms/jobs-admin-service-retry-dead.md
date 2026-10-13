---
id: jobs-admin-service-retry-dead
title: JobsAdminService.retryDead
kind: term
status: draft
aliases: [jobsadminservice, retrydead]
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# JobsAdminService.retryDead
## Definition
`JobsAdminService.retryDead` is the [operator](operator.md) function that brings a [`DEAD`](job-status.md) job back to life. It moves the job from `DEAD` to [`QUEUED`](job-status.md) and resets its attempts, so the job gets a full [retry budget](job-max-attempts.md) again. An operator is the only one who can make this move. Each retry writes an [audit log](audit-log.md) line. If two operators retry the same job at the same moment, only one of them gets the [`RETRIED`](job-retry-outcome.md) outcome.

## Example
A job reached `DEAD` after it used up its `maxAttempts`. An operator calls `JobsAdminService.retryDead` on it. The job is now `QUEUED` with `attempts = 0`, an audit log line is written, and the call returns `RETRIED` (S49.B-14).
Two operators call `retryDead` on the same job at the same time: one gets `RETRIED` and the other does not (S49 AS-45).

## Known gaps
- The spec does not say what `retryDead` returns when the job is not `DEAD`, when the id is unknown, or when the call loses a concurrent race. It only says that exactly one call returns `RETRIED`.
- The spec does not say what `runAt` the job gets when it is re-queued, or whether the call is limited to one shop the way `cancel` is.
- Not confirmed in the code: the facts do not list the file or symbol for `JobsAdminService`, so this page comes only from the spec.

## Used by
<!-- used-by:start -->
- [audit-log](audit-log.md)
- [job-max-attempts](job-max-attempts.md)
- [operator](operator.md)
<!-- used-by:end -->
