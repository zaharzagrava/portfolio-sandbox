---
id: schedule-enabled
title: Schedule enabled flag
kind: term
status: draft
aliases: [enabled, re-enabled]
defined_for: S49-job-scheduler
rules_hash: 304f9a1b80aa
---
# Schedule enabled flag
## Definition
Every [recurring schedule](time-zone-aware-cron.md) has an enabled flag. The [leader](scheduler-leader.md) [materialises fires](cron-schedule-materialisation.md) only for enabled schedules. An [operator](operator.md) can turn the flag on or off with `JobsAdminService.setScheduleEnabled`. The system also turns it off by itself when a schedule fails to materialise on several [ticks](scheduler-tick.md) in a row, and records the reason in [`lastError`](schedule-last-error.md). Re-enabling a schedule computes the next fire from the current time, so fires missed while it was off are not [caught up](cron-catch-up.md).

## Example
A schedule is disabled for 2 days and then re-enabled. Its next fire is computed from now, and no catch-up job is created for the 2 days.

## Known gaps
- The spec does not say whether [`upsertSchedule`](upsert-schedule.md), which replicas call at boot, turns a disabled schedule back on. This matters for a schedule that was disabled automatically.
- The spec does not say whether disabling a schedule cancels its jobs that are already [`QUEUED` or `RUNNING`](job-status.md).
- The spec does not say whether `lastError` is cleared when the schedule is re-enabled.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): B-20
- [cron-catch-up](cron-catch-up.md)
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [job-status](job-status.md)
- [operator](operator.md)
- [schedule-last-error](schedule-last-error.md)
- [scheduler-leader](scheduler-leader.md)
- [scheduler-tick](scheduler-tick.md)
- [time-zone-aware-cron](time-zone-aware-cron.md)
<!-- used-by:end -->
