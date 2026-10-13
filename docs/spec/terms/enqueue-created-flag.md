---
id: enqueue-created-flag
title: created flag of enqueue
kind: term
status: draft
aliases: [created: false, created: true]
defined_for: idempotency-key
rules_hash: 172edfc7b23c
---
# created flag of enqueue
## Definition
`created` is a boolean field in the reply to a [job enqueue](job-enqueue.md). `true` means this call created the job. `false` means a job with the same key already existed, so nothing new was created and the original job id comes back. Callers can read this flag to tell a fresh job from a retry that was [deduplicated ↗](../sw-external-terms.md#idempotency).

## Example
```json
{ "id": "job_8f2a1c", "created": false }
```
(The id value and the `id` field name are illustrative. The facts only say "the original id".)

## Known gaps
- The spec does not give the exact name of the id field in the reply.

## Used by
<!-- used-by:start -->
- [S49](../capabilities/S49-job-scheduler.md): R-04
- [job-enqueue](job-enqueue.md)
<!-- used-by:end -->
