---
id: job-payload-contract
title: Job payload contract
kind: term
status: draft
aliases: [contract, payload]
defined_for: S49-job-scheduler
rules_hash: b1568e2477e6
---
# Job payload contract
## Definition
The payload contract is the shape that a [job type's payload](job-type.md) must have. It is checked twice. At [enqueue](job-enqueue.md), a payload that breaks the contract is rejected and nothing is saved. At [claim time](job-claim.md), a stored payload that breaks the contract sends the job straight to [`DEAD`](job-status.md), with no [further attempts](job-attempt.md). The size limit on payloads is a separate check.

## Example
A caller enqueues a job with a payload that has a missing field. Enqueue rejects it, and no job or key exists afterwards. If an older job's stored payload no longer matches the contract when a worker claims it, the job becomes `DEAD` at once.

## Known gaps
- The spec does not say where or how the contract is declared, for example as a schema on the handler.
- The spec does not give the reason for the check at claim time. A likely reason is that the contract can change while a job waits in the queue. That is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-07
- [invalid-schedule-error](invalid-schedule-error.md)
- [job-attempt](job-attempt.md)
- [job-claim](job-claim.md)
- [job-enqueue](job-enqueue.md)
- [job-type](job-type.md)
<!-- used-by:end -->
