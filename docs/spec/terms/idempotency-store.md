---
id: idempotency-store
title: Idempotency store
kind: term
status: draft
aliases: [idempotency_unavailable]
defined_for: S54-platform-toolkit
rules_hash: 04d6537d507f
---
# Idempotency store
## Definition
The idempotency store holds the records behind the [Idempotency-Key header](idempotency-key.md): which keys have been seen, and the [stored answer](idempotency-stored-answer.md) for each one. With these records, a repeated request gets the stored response back instead of running the handler again. It is the `IdempotencyKey` table, owned by [`infrastructure:idempotency`](table-ownership.md), and the [idempotency key purge job](idempotency-purge-job.md) removes old entries. The store [fails closed ↗](../sw-external-terms.md#fail-open-fail-closed): if it cannot be reached, requests that need a key are refused, so a duplicate side effect is never possible.

## Example
The store is unreachable. A request arrives at a route declared with [`@Idempotent`](idempotent-decorator.md) that requires a key. The client gets `503 idempotency_unavailable`, and the handler does not run.

## Known gaps
- The spec does not say how long entries are kept before the purge job removes them.
- The spec does not say which database holds the `IdempotencyKey` table, or whether its writes share the handler's transaction.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-19
- [idempotency-key](idempotency-key.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [idempotency-stored-answer](idempotency-stored-answer.md)
- [idempotency-unavailable](idempotency-unavailable.md)
<!-- used-by:end -->
