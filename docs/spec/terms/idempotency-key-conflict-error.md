---
id: idempotency-key-conflict-error
title: IdempotencyKeyConflictError
kind: term
status: draft
aliases: []
defined_for: S49-job-scheduler
rules_hash: e3b0c44298fc
---
# IdempotencyKeyConflictError
## Definition
[Enqueue](job-enqueue.md) throws this error when a caller reuses an [idempotency key](idempotency-key.md) that already belongs to a job of a different [job type](job-type.md). No job is added. A reused key with the same type is not an error: enqueue returns the original id with [`created: false`](enqueue-created-flag.md). The error stops two unrelated pieces of work from silently sharing one key.

## Example
```ts
await jobs.enqueue('search.refresh-popularity', payload, { idempotencyKey: 'K' });   // created: true
await jobs.enqueue('search.retire-previous-index', payload, { idempotencyKey: 'K' }); // throws IdempotencyKeyConflictError
```
(The type names come from existing job pages. Pairing them on one key is illustrative.)

## Known gaps
- The spec does not say whether the same key with the same type but a different payload is a conflict. As written, it returns the original id.
- The spec does not say whether this error [rolls back ↗](../sw-external-terms.md#database-transaction) the caller's [open transaction](active-transaction.md). It only says that no job is added.

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [idempotency-key](idempotency-key.md)
- [job-enqueue](job-enqueue.md)
- [job-type](job-type.md)
<!-- used-by:end -->
