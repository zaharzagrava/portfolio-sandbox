---
id: checkout-unavailable
title: checkout_unavailable (503)
kind: term
status: draft
aliases: [checkout_unavailable]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# checkout_unavailable (503)
## Definition
`checkout_unavailable` is the answer [`POST /checkout`](post-checkout.md) gives when one of its [upstream calls](upstream.md) times out. That means either the catalog read (for prices, currency and shop) or the [catalog stock command](catalog-stock-command.md). Each call has its own timeout. The answer carries a [`Retry-After` header ↗](../sw-external-terms.md#retry-after) so the client knows when to try again.

## Example
The catalog read for the cart's products takes longer than its 1 s timeout, and the buyer receives:
```
HTTP/1.1 503 Service Unavailable
Retry-After: 2
```

## Known gaps
- The spec does not say what happens to the order and [the key](idempotency-key.md) when the *stock* call times out. Under S10.R-13, if an order already exists, the outcome may be final for that key. Under S10.R-24, the order may be left [`PENDING`](order-status.md) and later recovered.
- The spec does not say whether failures other than timeouts (errors or refused connections from the catalog) also return this code.

## Used by
<!-- used-by:start -->
- [catalog-stock-command](catalog-stock-command.md)
- [idempotency-key](idempotency-key.md)
- [upstream](upstream.md)
<!-- used-by:end -->
