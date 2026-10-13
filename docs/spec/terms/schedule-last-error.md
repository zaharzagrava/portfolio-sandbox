---
id: schedule-last-error
title: lastError
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# lastError
## Definition
`lastError` on a schedule records why the schedule stopped working. It is set when the schedule is disabled after repeated failed attempts to [materialise](cron-schedule-materialisation.md) it (see [schedule auto-disable](schedule-auto-disable.md)). Jobs have their own separate `lastError`, which records an attempt's failure, such as a timeout.

## Example
A schedule fails to materialise on several [ticks](scheduler-tick.md) in a row. It is disabled, and its `lastError` holds the most recent failure reason (illustrative content). For comparison, a job's `lastError` looks like `timeout after 5000 ms` (S49.B-06).

## Known gaps
- The spec does not say what text the schedule's `lastError` contains, or whether it is truncated like the job field.
- The spec does not say whether `lastError` is cleared when the schedule is [re-enabled](schedule-enabled.md), or whether `listSchedules` shows it.

## Used by
<!-- used-by:start -->
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [schedule-auto-disable](schedule-auto-disable.md)
- [schedule-enabled](schedule-enabled.md)
- [scheduler-tick](scheduler-tick.md)
<!-- used-by:end -->
