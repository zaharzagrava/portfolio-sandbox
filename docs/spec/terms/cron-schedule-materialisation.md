---
id: cron-schedule-materialisation
title: Schedule materialisation
kind: term
status: draft
aliases: [fire, schedules]
defined_for: job-scheduler-lease
rules_hash: 312d9e7927c6
---
# Schedule materialisation
## Definition
Schedule materialisation is how the scheduler leader turns cron schedules into real jobs in the database. When a schedule's fire time arrives, the leader enqueues a job for that fire, using the cron fire key as its idempotency key. Schedules are time-zone-aware: each cron expression is evaluated in its own time zone, then the fire time is stored in UTC. After materialisation, the job is leased, retried and reaped like any other job.

## Example
The schedule for `recommendations.build-bought-together` has the cron `17 3 * * *`. When 03:17 arrives in the schedule's time zone, the leader enqueues one job for that fire. A worker then claims the job, which builds and publishes all neighbour lists.

## Known gaps
- The spec does not say what happens when a new fire comes due while the previous run is still active. S49 has an overlap policy for this, but it is not in the rules.
- The spec does not say which time zone `17 3 * * *` uses for `recommendations.build-bought-together`.
- The spec does not say whether fires missed while no leader was running are caught up later or skipped.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-17
- [S34](../capabilities/S34-recommendations.md): B-19
- [S49](../capabilities/S49-job-scheduler.md): R-16, R-17, B-15, B-19
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-08
- [cron-fire-key](cron-fire-key.md)
- [cron-fires-skipped-total](cron-fires-skipped-total.md)
- [cron-overlap-policy](cron-overlap-policy.md)
- [invalid-schedule-error](invalid-schedule-error.md)
- [job-enqueue-key](job-enqueue-key.md)
- [schedule-auto-disable](schedule-auto-disable.md)
- [schedule-enabled](schedule-enabled.md)
- [schedule-last-error](schedule-last-error.md)
- [scheduler-leader](scheduler-leader.md)
- [scheduler-tick](scheduler-tick.md)
- [upsert-schedule](upsert-schedule.md)
<!-- used-by:end -->
