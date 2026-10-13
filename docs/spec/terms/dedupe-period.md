---
id: dedupe-period
title: Dedupe period
kind: term
status: draft
aliases: [dedupe window]
defined_for: S49-job-scheduler
rules_hash: 38f2706098ee
---
# Dedupe period
## Definition
The dedupe period is how long a [job enqueue key](job-enqueue-key.md) keeps blocking duplicate enqueues after its job has finished. During this time, an enqueue with the same key creates nothing. It returns the original job id with [`created: false`](enqueue-created-flag.md). When the period ends, the key is free, and a new enqueue with it creates a new job. The daily [`jobs.partition-maintenance`](jobs-partition-maintenance.md) schedule expires keys whose period has ended. Design intent (not stated in the spec): the period catches late retries from callers without keeping every key forever.

## Example
A job enqueued with key `invoice-42` (illustrative) finishes as [`SUCCEEDED`](job-status.md) on 2026-10-01 (illustrative).
- On 2026-10-20, `enqueue` with `invoice-42` returns the original id and `created: false`. No job is added.
- Once the 30 days in S49.R-06 have passed, the key is free. The next `enqueue` with `invoice-42` returns `created: true`.

## Known gaps
- The spec does not say which statuses count as "finished" for starting the period. For example, it does not say whether a `CANCELLED` job counts, or a [`DEAD`](job-status.md) job that an operator can still retry back to [`QUEUED`](job-status.md).
- The spec does not say whether enqueue checks the key's age itself or relies on the daily expiry. If it relies on the daily expiry, a key could keep blocking until the next `jobs.partition-maintenance` run. The expiry batch size (AS-87) is a P2 scenario and is not stated as a rule.
- Not confirmed in the code: the facts do not name the files for enqueue or key expiry, so the length of the period and where it is stored cannot be checked here.

## Used by
<!-- used-by:start -->
- [job-enqueue-key](job-enqueue-key.md)
- [jobs-partition-maintenance](jobs-partition-maintenance.md)
<!-- used-by:end -->
