---
id: job-last-error
title: lastError
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# lastError
## Definition
`lastError` is a text field that holds the message from the most recent failure. On a job it is set when an attempt fails, for example when [the handler throws or times out](job-handler.md). Schedules also have a `lastError`. It is set when a schedule is [disabled after too many failing ticks in a row](schedule-auto-disable.md) (S49.R-20). Long messages are cut to a maximum length. This is covered by a test (AS-23) but not by a rule.

## Example
A handler runs past [`maxRuntimeMs: 5000`](job-max-runtime.md), and the job's `lastError` becomes `timeout after 5000 ms` (S49.B-06).

## Known gaps
- The spec does not say whether `lastError` is cleared when a later attempt succeeds, or when an [operator](operator.md) retries a [`DEAD` job](job-status.md).
- The spec does not say whether operators can see `lastError` through `JobsAdminService.listJobs`.

## Used by
<!-- used-by:start -->
- [job-handler](job-handler.md)
- [job-status](job-status.md)
- [operator](operator.md)
- [schedule-auto-disable](schedule-auto-disable.md)
<!-- used-by:end -->
