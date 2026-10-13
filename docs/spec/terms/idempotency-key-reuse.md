---
id: idempotency-key-reuse
title: idempotency_key_reuse (422)
kind: term
status: draft
aliases: [idempotency_key_reuse]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# idempotency_key_reuse (422)
## Definition
`idempotency_key_reuse` is the validation answer `POST /checkout` gives when a buyer sends an Idempotency-Key they already used, but with a different request body. The server will not replay the old answer for a different request, and it will not run the new request under the old key. The client has to send a new key for the new request. Keys are scoped to the buyer, so another buyer can use the same key string without a clash.

## Example
A buyer checks out with key `order-try-0001` and `expectedTotalMinor: 2000`. Later they send the same key with `expectedTotalMinor: 2400` (values illustrative), and the server answers `422 idempotency_key_reuse`.

## Known gaps
- The spec does not say how two bodies are compared, for example by exact bytes, by normalised JSON, or by hash.
- The spec does not say how long a used key is kept. That decides when the same key can be used again with a new body.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
