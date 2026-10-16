---
id: cron-catch-up
title: Cron catch-up
kind: term
status: draft
aliases: [catch-up]
defined_for: S49-job-scheduler
rules_hash: ab8b98adef8b
---
# Cron catch-up
## Definition
Cron catch-up is how the scheduler handles fires it missed while no leader was running. All missed fires of a schedule collapse into a single catch-up job, not one job per missed fire. The next fire is then computed from the current time. This keeps downtime from causing a burst of jobs. A schedule that was disabled and then re-enabled gets no catch-up at all; its next fire is simply computed from now.

## Example
All instances are down for 3 days over a daily schedule. When they come back, the leader creates one catch-up job, not 3 (S49.B-16).

## Known gaps
- The spec does not say which `fireAt` the catch-up job's cron fire key uses: the earliest missed fire, the latest one, or the current time.
- The spec does not say whether the overlap policy `skip` can suppress the catch-up job when an earlier job of the schedule is still `QUEUED` or `RUNNING`.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): B-05
- [S14](../capabilities/S14-ledger-reconciliation.md): R-33
- [S49](../capabilities/S49-job-scheduler.md): B-16, B-20
- [cron-fires-skipped-total](cron-fires-skipped-total.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [provider-unavailable-failed-run](provider-unavailable-failed-run.md)
- [reconciliation-run-transition](reconciliation-run-transition.md)
- [reconciliation-run-uniqueness](reconciliation-run-uniqueness.md)
- [reconciliation-run](reconciliation-run.md)
- [reconciliation-schedule](reconciliation-schedule.md)
- [schedule-auto-disable](schedule-auto-disable.md)
- [schedule-enabled](schedule-enabled.md)
<!-- used-by:end -->
