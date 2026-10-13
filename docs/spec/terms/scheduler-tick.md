---
id: scheduler-tick
title: Scheduler tick
kind: term
status: draft
aliases: [ticks]
defined_for: job-scheduler-lease
rules_hash: 0412df7e4fec
---
# Scheduler tick
## Definition
A scheduler tick is one round of the scheduler's recurring loop. On each tick, every scheduler instance tries to take an [advisory lock ↗](../sw-external-terms.md#advisory-lock). The instance that gets it is the [scheduler leader](scheduler-leader.md) for that tick only, and it [materialises the cron schedules](cron-schedule-materialisation.md) that are due. Each tick picks the leader again, so a crashed leader does not block schedules for long. A unique key for each scheduled run stops two ticks from creating the same job twice.

## Example
On one tick, three scheduler instances try the advisory lock and only one gets it. That leader sees that `recommendations.build-bought-together` (`17 3 * * *`) is due. It [enqueues](job-enqueue.md) the job with a key like `cron:recommendations.build-bought-together:2026-10-13T03:17:00.000Z` (illustrative: this assumes the schedule's time zone is UTC and that the cron name matches the job name). The other two instances do nothing until the next tick.

## Known gaps
- The spec does not say how long a tick is, or whether ticks on different instances are aligned.
- The spec does not say what a tick does with fires that were missed or still running from an earlier fire. S49 has a cron overlap policy, but it is not in the rules.
- The spec does not say what happens if the leader crashes partway through a tick. The cron fire key should make the next tick's retry safe (design intent (not stated in the spec)).

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-16, R-20
- [cron-fire-key](cron-fire-key.md)
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [job-enqueue](job-enqueue.md)
- [jobs-partition-maintenance](jobs-partition-maintenance.md)
- [schedule-auto-disable](schedule-auto-disable.md)
- [schedule-enabled](schedule-enabled.md)
- [schedule-last-error](schedule-last-error.md)
- [scheduler-leader](scheduler-leader.md)
<!-- used-by:end -->
