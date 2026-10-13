---
id: fleet-concurrency
title: fleetConcurrency
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# fleetConcurrency
## Definition
`fleetConcurrency` is a setting on a [job handler](job-handler.md). It limits how many jobs of that type may be [`RUNNING`](job-status.md) at once across all [workers](worker-instance.md) combined. It is a [fleet-wide limit](fleet-wide-limit.md), not a per-worker limit. It is separate from the [per-shop cap](per-shop-running-cap.md), which limits running jobs per shop.

## Example
A handler declares `fleetConcurrency: 1`. There are 10 jobs of its type and 3 workers. At any instant at most 1 of those jobs is `RUNNING`, and the rest wait `QUEUED` (S49.B-04).

## Known gaps
- The spec does not say what the default is when a handler does not set `fleetConcurrency`. It also gives no rule for it, only behavior S49.B-04.
- The spec does not say how this limit combines with the per-shop cap when both apply to one job.
- Not confirmed in the code: where the option is declared. The [handler registry](job-type-registry.md) rules (AS-91 to AS-94) have tests but no rule on the page.

## Used by
<!-- used-by:start -->
- [fleet-wide-limit](fleet-wide-limit.md)
- [job-handler](job-handler.md)
- [job-type-registry](job-type-registry.md)
- [per-shop-running-cap](per-shop-running-cap.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
