---
id: scheduler-leader
title: Scheduler leader
kind: term
status: draft
aliases: [leader]
defined_for: job-scheduler-lease
rules_hash: 00497a8c4a99
---
# Scheduler leader
## Definition
The scheduler leader is the one scheduler instance allowed to turn [cron schedules](cron-schedule-materialisation.md) into [jobs](job-enqueue.md) during a given periodic scheduling pass. An [advisory lock ↗](../sw-external-terms.md#advisory-lock) chooses the leader again on every pass, so no instance holds leadership for long. This stops several instances from [materialising](cron-schedule-materialisation.md) the same schedules at the same time. Even if two instances did, a unique identifier for each scheduled run would stop duplicate jobs from being created.

## Example
Three scheduler instances wake on the same tick, and all try the advisory lock. Only the one that gets the lock materialises due schedules, such as `recommendations.build-bought-together` (`17 3 * * *`). The other two do nothing until the next tick.

## Known gaps
- The spec does not say how long a tick is.
- The spec does not say what happens if the leader crashes partway through a tick. The cron fire key makes a retry on the next tick safe, but that recovery is not stated.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-16, B-15
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-08
- [cron-fire-key](cron-fire-key.md)
- [cron-fires-skipped-total](cron-fires-skipped-total.md)
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [job-enqueue](job-enqueue.md)
- [schedule-auto-disable](schedule-auto-disable.md)
- [schedule-enabled](schedule-enabled.md)
- [scheduler-tick](scheduler-tick.md)
<!-- used-by:end -->
