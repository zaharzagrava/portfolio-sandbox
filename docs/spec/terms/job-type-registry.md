---
id: job-type-registry
title: Job type registry
kind: term
status: draft
aliases: [registered type]
defined_for: S49-job-scheduler
rules_hash: b9b2a5f47a47
---
# Job type registry
## Definition
The job type registry is the set of [job types](job-type.md) that have a [handler](job-handler.md). A domain registers a handler for a type with the [`@JobHandler`](job-handler.md) decorator, and handlers are discovered at boot. [Enqueue](job-enqueue.md) rejects a job whose type is not registered, and [`upsertSchedule`](upsert-schedule.md) rejects a schedule that names one. A worker [claims](job-claim.md) only jobs whose types it has a handler for. Handler settings such as [`leaseMs`](job-lease-ms.md), [`fleetConcurrency`](fleet-concurrency.md) and [`maxRuntimeMs`](job-max-runtime.md) are attached to the registered type.

## Example
A domain marks a class with `@JobHandler` for `search.refresh-popularity`. After boot, `JobsService.enqueue('search.refresh-popularity', payload, options)` is accepted. Enqueueing a type that nobody registered fails, and nothing is saved.

## Known gaps
- The spec does not say how an app that enqueues jobs but runs no handlers knows which types are registered. This matters if you enqueue from outside the worker app.
- Not confirmed in the code: the registry's file or symbol name. The handler registry rules (AS-91 to AS-94) have tests but are not stated as rules here.
- The spec does not say what happens to jobs that are already queued for a type whose handler is later removed. They would match no worker's claim.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): B-18
- [fleet-concurrency](fleet-concurrency.md)
- [invalid-schedule-error](invalid-schedule-error.md)
- [job-claim](job-claim.md)
- [job-enqueue](job-enqueue.md)
- [job-handler](job-handler.md)
- [job-type](job-type.md)
<!-- used-by:end -->
