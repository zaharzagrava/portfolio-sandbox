---
id: job-cancel
title: Job cancel
kind: term
status: draft
aliases: [cancel, cancelled]
defined_for: S49-job-scheduler
rules_hash: c2d39a69d909
---
# Job cancel
## Definition
Job cancel stops a job that has not started yet, moving it from [`QUEUED`](job-status.md) to [`CANCELLED`](job-status.md). Other capabilities call `JobsService.cancel` (by id) or `cancelByKey` (by [idempotency key](job-enqueue-key.md)). Operators use [`JobsAdminService.cancel`](operator.md). [Cancel and claim exclude each other](job-claim.md), so a job is either cancelled or run, never both. Jobs in any other status cannot be cancelled and return a [`CONFLICT`](job-cancel-outcome.md) outcome.

## Example
- `cancel(id)` on a `QUEUED` job → `CANCELLED`
- `cancel(id)` on a `RUNNING` job → `CONFLICT` with status `RUNNING`
- `cancel(id)` on an unknown id, or [another shop's job](shop-tenant.md) → [`NOT_FOUND`](job-cancel-outcome.md) (S49.B-13)

## Known gaps
- The spec does not say what `cancelByKey` returns for an unknown key, or whether it follows the same shop scoping as `cancel`.
- The spec does not describe any way to stop a job that is already `RUNNING`.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-10
- [job-claim](job-claim.md)
- [job-enqueue-key](job-enqueue-key.md)
- [shop-tenant](shop-tenant.md)
<!-- used-by:end -->
