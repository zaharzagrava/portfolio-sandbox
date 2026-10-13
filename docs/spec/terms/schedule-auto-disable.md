---
id: schedule-auto-disable
title: Schedule auto-disable
kind: term
status: draft
aliases: [disabled]
defined_for: S49-job-scheduler
rules_hash: 3fca08eb27ba
---
# Schedule auto-disable
## Definition
Schedule auto-disable turns off a schedule that keeps failing to [materialise](cron-schedule-materialisation.md). After a run of consecutive failing [ticks](scheduler-tick.md), the [leader](scheduler-leader.md) disables the schedule and sets its [`lastError`](schedule-last-error.md). A failing schedule never blocks other schedules from materialising, before or after it is disabled. An [operator](operator.md) can turn it back on with `JobsAdminService.setScheduleEnabled`. The next fire is then computed from the current time, with [no catch-up](cron-catch-up.md).

## Example
Schedule `s` fails on 5 consecutive ticks, so it is disabled with `lastError` set while other schedules keep firing. Two days later an operator re-enables it. It fires next at its next regular time after now, and the two days of missed fires are not replayed (S49.B-20).

## Known gaps
- The spec does not say what counts as a failing tick, or whether one successful tick resets the count.
- The spec does not say whether `upsertSchedule` at boot re-enables an auto-disabled schedule.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-20
- [cron-catch-up](cron-catch-up.md)
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [job-last-error](job-last-error.md)
- [operator](operator.md)
- [schedule-last-error](schedule-last-error.md)
- [scheduler-leader](scheduler-leader.md)
- [scheduler-tick](scheduler-tick.md)
<!-- used-by:end -->
