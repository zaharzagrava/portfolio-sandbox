---
id: job-handler
title: Job handler
kind: term
status: draft
aliases: [handlers]
defined_for: S49-job-scheduler
rules_hash: d13431b071ad
---
# Job handler
## Definition
A job handler is the domain code that does the work for one kind of background job. It is registered with `@JobHandler` and discovered when the app boots. A handler declares its [`leaseMs`](job-lease-ms.md), and may also declare [`maxRuntimeMs`](job-max-runtime.md) and [`fleetConcurrency`](fleet-concurrency.md). It receives a stop signal that aborts with reason `timeout` or `shutdown`. If it throws, the job is retried, but if it throws `NonRetryableJobError`, the job goes straight to `DEAD`.

## Example
```ts
@JobHandler({ type: 'search.refresh-popularity', leaseMs: 30000, maxRuntimeMs: 5000, fleetConcurrency: 1 })
```
(The decorator's argument shape and these values are illustrative. Only the option names come from the spec.) If this handler runs past 5000 ms, `lastError` is `timeout after 5000 ms` and the retry path runs.

## Known gaps
- The spec does not state the handler context fields or the explicit `ctx.heartbeat()` as rules (AS-22). They have tests only.
- The spec does not say that a handler must be idempotent. The scheduler delivers at least once, so a handler can run twice for one job and should be safe to repeat. That is design intent (not stated in the spec).
- Not confirmed in the code: the code facts do not list the decorator's file or symbol.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-08, B-03
- [entry-point](entry-point.md)
- [failures-only-policy](failures-only-policy.md)
- [fleet-concurrency](fleet-concurrency.md)
- [job-due](job-due.md)
- [job-heartbeat](job-heartbeat.md)
- [job-last-error](job-last-error.md)
- [job-lease-ms](job-lease-ms.md)
- [job-type-registry](job-type-registry.md)
- [job-type](job-type.md)
- [permanent-error](permanent-error.md)
<!-- used-by:end -->
