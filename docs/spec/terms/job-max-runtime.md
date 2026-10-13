---
id: job-max-runtime
title: maxRuntimeMs
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# maxRuntimeMs
## Definition
`maxRuntimeMs` is the longest time one attempt of a handler may run. When the time runs out, the job's [stop signal](job-stop-signal.md) aborts with reason `timeout`. [`lastError`](job-last-error.md) records the timeout, and the job follows the [normal retry path](job-retries.md). This is separate from the [lease](job-lease.md): a [heartbeat](job-heartbeat.md) keeps the lease alive, but it does not extend the maximum runtime.

## Example
A handler with `maxRuntimeMs: 5000` is still running after 5 s. Its stop signal aborts with reason `timeout`, and `lastError` becomes `timeout after 5000 ms`. The job is then re-queued, or becomes `DEAD` if it has reached `maxAttempts` (S49.B-06).

## Known gaps
- The spec does not say what the default is when it is not set. It also gives no rule for it, only behavior S49.B-06.
- The spec does not say what happens if the handler ignores the stop signal and keeps running.
- The spec does not say directly whether `maxRuntimeMs` is set per handler or per job. The enqueue options do not include it, which suggests it is set per handler.

## Used by
<!-- used-by:start -->
- [job-heartbeat](job-heartbeat.md)
- [job-lease](job-lease.md)
- [job-retries](job-retries.md)
- [job-stop-signal](job-stop-signal.md)
<!-- used-by:end -->
