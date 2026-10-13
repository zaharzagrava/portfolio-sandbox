---
id: cron-fires-skipped-total
title: cron_fires_skipped_total
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# cron_fires_skipped_total
## Definition
`cron_fires_skipped_total` is one of the metrics of the distributed job scheduler, listed among its [entry points](entry-point.md). Its name says it counts [cron fires](cron-schedule-materialisation.md) that came due but created no job. The spec gives no rule or behavior for it, so it does not define exactly which fires are counted. Operators would use it to see how often schedules fire without producing work. That use is design intent (not stated in the spec).

## Example
A daily schedule uses the [overlap policy `skip`](cron-overlap-policy.md), and its previous job is still [`RUNNING`](job-status.md) when the next fire comes due. The [leader](scheduler-leader.md) creates no job for that fire. Going by the metric's name, `cron_fires_skipped_total` would go up by one (illustrative; no rule confirms it).

## Known gaps
- The spec does not say which events increase this counter. It could be overlap `skip`, missed fires merged into one [catch-up job](cron-catch-up.md), disabled schedules, or more than one of these.
- The spec does not say which labels the metric has, for example a schedule name. Metrics (AS-77 to AS-83) are marked P2, and no rule or behavior cites them.
- Not confirmed in the code: the code facts don't list the cron materialiser, so where this metric is emitted isn't known.

## Used by
<!-- used-by:start -->
- [auth-purge-reset-tokens-job](auth-purge-reset-tokens-job.md)
- [cron-catch-up](cron-catch-up.md)
- [cron-overlap-policy](cron-overlap-policy.md)
- [cron-schedule-materialisation](cron-schedule-materialisation.md)
- [entry-point](entry-point.md)
- [scheduler-leader](scheduler-leader.md)
<!-- used-by:end -->
