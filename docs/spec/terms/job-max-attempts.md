---
id: job-max-attempts
title: maxAttempts
kind: term
status: draft
aliases: []
defined_for: job-scheduler-lease
rules_hash: 943eb7b18821
---
# maxAttempts
## Definition
`maxAttempts` is the limit on how many [attempts](job-attempt.md) a job gets before the system gives up. A failing job that reaches it becomes [`DEAD`](job-status.md) instead of being [re-queued with backoff](job-retries.md). [The reaper](job-reaper.md) applies the same limit: an [expired-lease](job-lease.md) job that reaches it is killed, not re-queued.

## Example
A job with an illustrative `maxAttempts` of 5 fails on its 5th attempt. It is not scheduled again and becomes `DEAD`.

## Known gaps
- The spec does not say what the default `maxAttempts` value is.
- The spec does not say whether `maxAttempts` is set for each job at [enqueue](job-enqueue.md), for each job type, or for the whole system.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-28
- [job-attempt](job-attempt.md)
- [job-enqueue](job-enqueue.md)
- [job-lease](job-lease.md)
- [job-reaper](job-reaper.md)
- [job-retries](job-retries.md)
- [jobs-admin-service-retry-dead](jobs-admin-service-retry-dead.md)
<!-- used-by:end -->
