---
id: jobs-partition-maintenance
title: jobs.partition-maintenance schedule
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: fb0c7df52b48
---
# jobs.partition-maintenance schedule
## Definition
`jobs.partition-maintenance` is a [recurring schedule](time-zone-aware-cron.md) that the [job scheduler](../capabilities/S49-job-scheduler.md) owns and registers for itself. Once a day it creates new [creation-date partitions ↗](../sw-external-terms.md#table-partitioning) for the job tables and drops old ones. It also expires [idempotency keys](job-enqueue-key.md) whose [dedupe period](dedupe-period.md) has ended, which frees them for reuse. Only one run is allowed at a time. Because the work must happen once per day across the whole fleet, it is a schedule and not the in-process [local ticker](scheduler-tick.md). That local ticker runs on every replica.

## Example
The schedule runs at `15 3 * * *` in UTC with concurrency 1. Each daily fire gets a [cron fire key](cron-fire-key.md) built by S49.R-16, for example (date is illustrative):
```
cron:jobs.partition-maintenance:2026-10-14T03:15:00.000Z
```

## Known gaps
- The spec does not say when a partition gets dropped, how far ahead partitions are created, or how rows in the default partition are handled. These are P2 retention scenarios (AS-84 to AS-86) and are not stated as rules. Only the metric `job_default_partition_rows` hints that rows in the default partition are watched.
- The spec does not say which job type or handler the schedule creates. It also does not say whether "concurrency 1" is the handler's [`fleetConcurrency`](fleet-concurrency.md) setting.
- Not confirmed in the code: the facts do not list the code files for this schedule, partition creation and dropping, or key expiry. Only the migration `packages/backend/migrations/20261001110000-create-jobs.js` and the ownership registry are named.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-15
- [cron-fire-key](cron-fire-key.md)
- [dedupe-period](dedupe-period.md)
- [job-enqueue-key](job-enqueue-key.md)
- [scheduler-tick](scheduler-tick.md)
- [time-zone-aware-cron](time-zone-aware-cron.md)
<!-- used-by:end -->
