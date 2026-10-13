---
id: checkout-request-schema
title: checkoutRequestSchema
kind: term
status: draft
aliases: []
defined_for: W03-cart-checkout-orders
rules_hash: e3b0c44298fc
---
# checkoutRequestSchema
## Definition
`checkoutRequestSchema` is the schema that defines which fields a [checkout (place order) request](post-checkout.md) body may carry. The server checks it before adding the [referral code](referral-code.md) from the [`__Host-ref` cookie](host-ref-cookie.md). If the schema does not declare a referral field, the server leaves the code out. The design intent (not stated in the spec) is to avoid sending a field the checkout endpoint would reject as [unknown](unknown-body-field.md).

## Example
The schema declares a referral field, so the server adds the code from `__Host-ref` to the order request. If a later version removes that field, the order is sent without the referral (rule W03.R-16).

## Known gaps
- The spec does not list the fields of `checkoutRequestSchema` or say whether it declares a referral field today.
- Not confirmed in the code: the file that defines `checkoutRequestSchema`, or whether the browser and server share it.

## Used by
<!-- used-by:start -->
- [host-ref-cookie](host-ref-cookie.md)
- [post-checkout](post-checkout.md)
- [referral-code](referral-code.md)
- [unknown-body-field](unknown-body-field.md)
<!-- used-by:end -->
