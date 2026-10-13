---
id: entry-point
title: Entry point
kind: term
status: draft
aliases: [entry points]
defined_for: S49-job-scheduler
rules_hash: 27fac4d25609
---
# Entry point
## Definition
An entry point is a way into a [capability](capability.md): a place where other code, operators or the runtime start its work or watch it. Each capability page lists its entry points in an "Entry points" section. For [S49](../capabilities/S49-job-scheduler.md) that list has service methods, a [handler decorator](job-handler.md), background loops in the [worker app](worker-instance.md), operator functions, a schedule and metrics. Other capabilities should reach the [job tables](table-ownership.md) only through exported services such as these, never by touching the tables directly. The metrics are outputs you read, not calls you make, but the page still lists them as entry points.

## Example
- A domain calls [`JobsService.enqueue(type, payload, options)`](job-enqueue.md) and receives `{ id, created }`.
- A domain marks a class with `@JobHandler` so its handler is found at boot.
- An operator calls [`JobsAdminService.retryDead`](jobs-admin-service-retry-dead.md) to put a [`DEAD`](job-status.md) job back to [`QUEUED`](job-status.md).

## Known gaps
- The spec does not say which entry points other capabilities may call and which are internal. The background loops and metrics are listed beside the public `JobsService` methods without any marking.
- Not confirmed in the code: only `packages/backend/apps/worker/src/worker.module.ts#WorkerModule` is cited. The files for `JobsService`, `JobsAdminService` and `@JobHandler` are not listed.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [code-facts](code-facts.md)
- [cron-fires-skipped-total](cron-fires-skipped-total.md)
- [job-handler](job-handler.md)
- [navbar-menu-entry](navbar-menu-entry.md)
- [not-found-state](not-found-state.md)
- [table-ownership](table-ownership.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
