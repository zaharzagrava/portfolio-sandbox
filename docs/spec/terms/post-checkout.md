---
id: post-checkout
title: POST /checkout
kind: term
status: draft
aliases: []
defined_for: idempotency-key
rules_hash: f60eb5f41d87
---
# POST /checkout
## Definition
`POST /checkout` is the route that places an order from the cart. It belongs to [S10 (cart and checkout)](../capabilities/S10-cart-checkout.md). It requires an [`Idempotency-Key` header](idempotency-key.md) and checks the key's length. Without the key, it answers [`422 idempotency_key_required`](idempotency-key.md). A retry with the same key creates no second order, so a double press or reload in the checkout UI ([W03](../capabilities/W03-cart-checkout-orders.md)) still gives one order.

## Example
The checkout UI sends the order with the key of the current attempt:
```http
POST /checkout
Idempotency-Key: 3f9c2a7e-checkout-0001   (illustrative value, within 8 to 128 characters)
```
If the user presses "Place order" twice, both requests carry this key and only one order is created. The same request without the header gets `422 idempotency_key_required`.

## Known gaps
- The spec does not say what `POST /checkout` returns on success, or whether a retry with the same key returns the original order's response.
- The spec does not say how the route answers a repeated key that comes with a different request body, such as a cart that changed between retries.
- Not confirmed in the code: the spec infers that `POST /checkout` is declared with [`@Idempotent`](idempotent-decorator.md), and that retries with the same key count against its rate limit, from the S10, S13 and S50 lines. The S54 lines that would confirm this were not given.

## Used by
<!-- used-by:start -->
- [cart-badge](cart-badge.md)
- [checkout-request-schema](checkout-request-schema.md)
- [checkout-review-step](checkout-review-step.md)
- [expected-total-minor](expected-total-minor.md)
- [host-ref-cookie](host-ref-cookie.md)
- [idempotency-key](idempotency-key.md)
- [out-of-stock-error](out-of-stock-error.md)
- [stock-operation-ordering](stock-operation-ordering.md)
<!-- used-by:end -->
