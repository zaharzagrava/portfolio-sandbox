---
id: cron-overlap-policy
title: Cron overlap policy
kind: term
status: draft
aliases: [allow, overlap, skip]
defined_for: S49-job-scheduler
rules_hash: f0e5c2dcb212
---
# Cron overlap policy
## Definition
The overlap policy is a per-[schedule](cron-schedule-materialisation.md) setting that controls what happens when a [cron fire](cron-schedule-materialisation.md) comes due while an earlier job from the same schedule is still active. With `skip` (the default), the fire creates no job if an earlier job of the schedule is [`QUEUED`](job-status.md) or `RUNNING`. With `allow`, every fire creates a job, so runs can overlap.

## Example
A daily schedule's previous job is still `RUNNING` when the next fire comes due. With `skip`, no new job is created for that fire. With `allow`, a second job is created and both may run at the same time.

## Known gaps
- The spec does not say where the policy is set. It is presumably part of the definition passed to [`upsertSchedule`](upsert-schedule.md), but the spec does not confirm this.
- The spec does not say whether skipped fires are counted by [`cron_fires_skipped_total`](cron-fires-skipped-total.md). The name suggests it, but no rule links them.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-18
- [cron-fires-skipped-total](cron-fires-skipped-total.md)
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [upsert-schedule](upsert-schedule.md)
<!-- used-by:end -->
