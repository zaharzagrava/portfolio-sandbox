---
id: search-refresh-popularity
title: search.refresh-popularity job
kind: term
status: draft
aliases: [search.refresh-popularity]
defined_for: job-scheduler-lease
rules_hash: d4865d7d5273
---
# search.refresh-popularity job
## Definition
`search.refresh-popularity` is a background job type that S32 runs on the [distributed job scheduler](../capabilities/S49-job-scheduler.md). Like every scheduled job, it runs under a [lease](job-lease.md), is retried with backoff when it throws, and becomes [`DEAD`](job-status.md) after `maxAttempts`. Its name suggests it updates popularity data for product search. The spec does not say what it computes or writes.

## Example
A worker claims a `search.refresh-popularity` job and moves it from `QUEUED` to `RUNNING`. Say the job throws on its first attempt. It goes back to `QUEUED` with a [jittered](jitter.md) delay of at most 2 s (`1 s × 2^1`), and another worker can then claim it.

## Known gaps
- The spec does not say what triggers this job: a cron schedule (and if so which expression), an enqueue from code, or both.
- The spec does not say whether the job carries a shop, so it is unclear whether the [per-shop cap](per-shop-running-cap.md) applies to it.
- Not confirmed in the code: that this job produces the data used by [relevance boosts](relevance-boost.md). The only hint is the job's name.

---

The "Found in" text you gave for all three terms is the same paragraph, and it is the relevance-boosts page, not text from these terms. So the only facts I had about these features came from the S32 one-line summary and the job-scheduler rules. That is why each page has several gaps.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-04
- [jitter](jitter.md)
- [job-lease](job-lease.md)
- [per-shop-running-cap](per-shop-running-cap.md)
- [relevance-boost](relevance-boost.md)
<!-- used-by:end -->
