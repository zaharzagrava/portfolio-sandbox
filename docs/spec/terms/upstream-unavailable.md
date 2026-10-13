---
id: upstream-unavailable
title: upstream_unavailable (503)
kind: term
status: draft
aliases: [upstream_unavailable]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# upstream_unavailable (503)
## Definition
`upstream_unavailable` is the [whole-page error](page-aggregate.md) returned when the [product upstream](upstream.md) keeps answering 503. The [BFF ↗](../sw-external-terms.md#bff) retries the product call once, with [jitter](jitter.md). If the second attempt is also a 503, it returns this error with a [`Retry-After` ↗](../sw-external-terms.md#retry-after) header. It is different from the uppercase [`UPSTREAM_UNAVAILABLE`](upstream-unavailable-field-code.md) code, which marks a single failed GraphQL field.

## Example
The product upstream answers 503, the BFF waits a short jittered delay and tries again, and the upstream answers 503 again. The client gets:
```
HTTP/1.1 503
Retry-After: 2        (illustrative value)
```
The body carries `upstream_unavailable`.

## Known gaps
- The spec does not say how the `Retry-After` value is chosen.
- The spec does not say what the page returns for product failures other than 503 (timeouts, connection errors).
- Not confirmed in the code: the backoff range used between the two product attempts.

## Used by
<!-- used-by:start -->
- [jitter](jitter.md)
- [page-aggregate](page-aggregate.md)
- [upstream-unavailable-field-code](upstream-unavailable-field-code.md)
- [upstream](upstream.md)
<!-- used-by:end -->
