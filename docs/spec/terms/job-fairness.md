---
id: job-fairness
title: Job fairness
kind: term
status: draft
aliases: [fairness]
defined_for: idempotency-key
rules_hash: a3aac515bad3
---
# Job fairness
## Definition
Job fairness is [S49](../capabilities/S49-job-scheduler.md)'s way of sharing workers between different [sources of jobs](job-source.md). Its goal is that one busy source cannot delay everyone else's jobs. The S49 capability title names fairness, but the spec does not say what is shared fairly or how. Design intent (not stated in the spec): one [tenant](tenant.md) enqueuing a large burst should not make other tenants' jobs wait until that burst is done.

## Example
Source A enqueues 10,000 jobs and then source B enqueues 5 jobs (illustrative). With fairness, B's jobs run soon, mixed in with A's. Without it, B's jobs would wait until all of A's jobs finish.

## Known gaps
- The spec does not say which unit fairness applies to, for example tenant, shop, queue or job type.
- The spec does not say which method is used, for example [round-robin ↗](../sw-external-terms.md#round-robin) or weights, or whether jobs can have priorities.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-15
- [job-source](job-source.md)
- [tenant](tenant.md)
<!-- used-by:end -->
