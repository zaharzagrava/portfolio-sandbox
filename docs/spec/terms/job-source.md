---
id: job-source
title: Job source
kind: term
status: draft
aliases: [source, sources]
defined_for: idempotency-key
rules_hash: 3a2ce4b8f93b
---
# Job source
## Definition
A job source is whoever or whatever enqueues jobs into S49, the distributed job scheduler. Job fairness shares workers between sources, so one busy source cannot hold up everyone else's jobs. The spec does not name the unit that counts as a source. Possible units are a tenant, a shop, a queue or a job type. Related S49 terms are the per-shop running cap and shopless jobs. Design intent (not stated in the spec): a shop may be the natural source unit, because S49 already limits how many jobs one shop can have running.

## Example
Source A enqueues 10,000 jobs, and then source B enqueues 5 jobs (illustrative values). With fairness, B's jobs run soon, mixed in with A's jobs. They do not wait behind A's whole burst.

## Known gaps
- The spec does not say what counts as a job source, for example a tenant, a shop, a queue or a job type.
- The spec does not say which source a shopless job belongs to for fairness.
- Not confirmed in the code: whether a job records its source in a field, or which field that is.

## Used by
<!-- used-by:start -->
- [gallery-event](gallery-event.md)
- [job-fairness](job-fairness.md)
<!-- used-by:end -->
