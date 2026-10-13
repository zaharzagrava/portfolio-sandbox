---
id: job-stop-signal
title: Job stop signal
kind: term
status: draft
aliases: [abort signal]
defined_for: S49-job-scheduler
rules_hash: f298644ddd99
---
# Job stop signal
## Definition
The stop signal is a [cancellation signal ↗](../sw-external-terms.md#abort-signal) that the worker gives to a running handler. The worker fires it to ask the handler to stop, and it carries a reason. The reason `timeout` means the attempt ran past [`maxRuntimeMs`](job-max-runtime.md). The reason `shutdown` means the worker reached its [drain deadline](shutdown-deadline.md). A handler is expected to watch the signal and stop cleanly. That is design intent (not stated in the spec).

## Example
- Reason `timeout`: [`lastError`](job-last-error.md) becomes `timeout after 5000 ms` and the retry path runs (S49.B-06).
- Reason `shutdown`: the job returns to [`QUEUED`](job-status.md) with [`runAt = now`](job-run-at.md) and the attempt refunded (S49.B-11).

## Known gaps
- The spec does not say what happens if a handler ignores the signal.
- Not confirmed in the code: the exact type and field name in the handler context. The context fields (AS-22) have tests but no rule.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): B-06
- [job-max-runtime](job-max-runtime.md)
- [shutdown-deadline](shutdown-deadline.md)
<!-- used-by:end -->
