---
id: job-reaper
title: Job reaper
kind: term
status: draft
aliases: [reaper]
defined_for: job-scheduler-lease
rules_hash: 32de461df7d7
---
# Job reaper
## Definition
The job reaper is a background process that finds [`RUNNING`](job-status.md) jobs whose [lease](job-lease.md) has expired. It puts each such job back to `QUEUED`, or marks it [`DEAD`](job-status.md) if the job has reached [`maxAttempts`](job-max-attempts.md). Each expired job is handled only once, even when several reaper instances run at the same time. The reaper never changes a job's [`attempts`](job-attempt.md) count.

## Example
A worker claims `search.refresh-popularity` and then crashes, so its lease expires while the job is still `RUNNING`. The reaper re-queues the job without changing `attempts`, and another worker can claim it. If the job had already reached `maxAttempts`, the reaper would mark it `DEAD` instead.

## Known gaps
- The spec does not say how often the reaper runs or how it finds expired leases.
- The spec does not say how several reaper instances avoid handling the same job twice. The rules only require that each job is handled once.
- The spec does not say why `attempts` must stay unchanged. A likely reason is that the attempt was already counted when the job was claimed. This is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-14, B-07, B-08
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-06
- [attempt-fencing](attempt-fencing.md)
- [fleet-wide-limit](fleet-wide-limit.md)
- [job-attempt](job-attempt.md)
- [job-heartbeat](job-heartbeat.md)
- [job-lease-ms](job-lease-ms.md)
- [job-lease](job-lease.md)
- [job-max-attempts](job-max-attempts.md)
- [job-retry-delay](job-retry-delay.md)
- [job-status](job-status.md)
- [search-retire-previous-index](search-retire-previous-index.md)
- [stale-worker](stale-worker.md)
<!-- used-by:end -->
