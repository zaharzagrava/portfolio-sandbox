---
id: product-unavailable
title: product_unavailable (422)
kind: term
status: draft
aliases: [product_unavailable]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# product_unavailable (422)
## Definition
`product_unavailable` is the `422` error code that `POST /checkout` returns when a cart line cannot be sold. This happens when the product is unknown, archived or a sandbox product. It also happens when the product's shop is not `ACTIVE`. Checkout reads this from the catalog, not from the client.

## Example
A cart holds a product that the seller archived after it was added. `POST /checkout` answers `422` with code `product_unavailable`.

## Known gaps
- The spec does not say whether the response lists the affected product IDs, the way `out_of_stock` does with `productIds`.
- The spec does not say whether this check happens before an order is created. That affects whether the idempotency key is released.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
