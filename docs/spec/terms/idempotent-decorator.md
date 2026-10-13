---
id: idempotent-decorator
title: @Idempotent route decorator
kind: term
status: draft
aliases: [@idempotent, idempotent]
defined_for: idempotency-key
rules_hash: 8751cce5a147
---
# @Idempotent route decorator
## Definition
`@Idempotent` is a declaration from the [platform toolkit](platform-toolkit.md) (S54) that you put on a route to mark it as [idempotent ↗](../sw-external-terms.md#idempotency). A route declared this way requires an [`Idempotency-Key` header](idempotency-key.md) on every request. S54 also includes a [purge job](idempotency-purge-job.md) that deletes old keys. The idea is that the route gets idempotency from this one declaration instead of each handler writing its own key handling. That idea is design intent (not stated in the spec).

## Example
A client sends `POST /checkout` with no `Idempotency-Key` header. The route rejects it with [`422 idempotency_key_required`](idempotency-key.md) and creates no order.

## Known gaps
- The spec does not say which routes carry `@Idempotent`. Its link to `POST /checkout` and `POST /payments/intents` is inferred from the S10 and S13 lines, not from S54.
- The spec does not say how the decorated route answers a repeated key that comes with a different request body.
- The spec does not say where keys are stored, how long they live, or when the purge job runs.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-17
- [idempotency-key](idempotency-key.md)
- [idempotency-purge-job](idempotency-purge-job.md)
- [platform-toolkit](platform-toolkit.md)
<!-- used-by:end -->
