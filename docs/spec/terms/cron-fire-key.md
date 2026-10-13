---
id: cron-fire-key
title: Cron fire key
kind: term
status: draft
aliases: []
defined_for: job-scheduler-lease
rules_hash: 13f891a813f5
---
# Cron fire key
## Definition
The cron fire key is the [idempotency key](idempotency-key.md) the [scheduler leader](scheduler-leader.md) uses when it enqueues a job for one [schedule fire](cron-schedule-materialisation.md). It has the form `cron:<name>:<fireAt>`, where `fireAt` is [ISO-8601 ↗](../sw-external-terms.md#iso-8601) UTC with milliseconds. Each fire therefore has one fixed key. Enqueuing the same fire again creates nothing and returns [`created: false`](enqueue-created-flag.md).

## Example
These values are illustrative: they assume the schedule name equals the job type and the cron runs in UTC.
```
cron:recommendations.build-bought-together:2026-10-14T03:17:00.000Z
```
A second enqueue with this key returns the original job id with `created: false`.

## Known gaps
- The spec does not say whether `<name>` is the schedule name or the job type, or whether they are always the same.
- The spec does not say in its rules how long fire keys are kept. [S49](../capabilities/S49-job-scheduler.md) has a key-retention fact that the rules do not include. If a key is purged, the same fire could in principle be enqueued again.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): B-19
- [S49](../capabilities/S49-job-scheduler.md): R-16
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [idempotency-key](idempotency-key.md)
- [jobs-partition-maintenance](jobs-partition-maintenance.md)
- [scheduler-leader](scheduler-leader.md)
- [scheduler-tick](scheduler-tick.md)
<!-- used-by:end -->
