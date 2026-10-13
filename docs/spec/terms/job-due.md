---
id: job-due
title: Due job
kind: term
status: draft
aliases: [due]
defined_for: S49-job-scheduler
rules_hash: c32e04f84d7c
---
# Due job
## Definition
A due job is a [`QUEUED`](job-status.md) job whose [`runAt`](job-run-at.md) time has arrived, so a worker may now [claim](job-claim.md) it. A job with a future `runAt` is not due. It stays `QUEUED` and its [attempts](job-attempt.md) are not touched. Workers claim due jobs in `runAt` order, then by id. They only claim types they have a [handler](job-handler.md) for.

## Example
A job enqueued at 10:00Z with `runAt` 20:00Z is not due when a worker polls at 19:59:59Z. It stays `QUEUED` with `attempts = 0` (S49.B-01). With 1,000 due jobs and 4 workers, every job runs exactly once and ends [`SUCCEEDED`](job-status.md) (S49.B-03).

## Known gaps
- The spec does not say whether "due" means `runAt` is at or before the database clock, or at or before the worker clock.
- Not confirmed in the code: the claim query. The code facts do not list the claim code file or symbols.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-27
- [S49](../capabilities/S49-job-scheduler.md): B-03
- [job-attempt](job-attempt.md)
- [job-claim](job-claim.md)
- [job-handler](job-handler.md)
<!-- used-by:end -->
