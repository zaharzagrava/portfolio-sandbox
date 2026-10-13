---
id: host-ref-cookie
title: __Host-ref cookie
kind: term
status: draft
aliases: [__host-ref]
defined_for: W03-cart-checkout-orders
rules_hash: 8c73230fb00d
---
# __Host-ref cookie
## Definition
`__Host-ref` is the cookie that carries a code identifying who referred the visitor. Browser code must never read it. Only the server uses it: when it [forwards a checkout request](bff-forwarder.md), it adds the code to that request. It does this only if [`checkoutRequestSchema`](checkout-request-schema.md) declares a field for the code. The design intent (not stated in the spec) is that a code the page never sees can't be read or changed by page scripts.

## Example
A member who has a `__Host-ref` cookie presses [**Place order**](post-checkout.md). The browser sends the order without any referral data. The server adds the referral code to the request only if `checkoutRequestSchema` has the field (rule W03.R-16).

## Known gaps
- The spec does not say what sets the `__Host-ref` cookie, how long it lasts, or what the referral code looks like.
- The spec does not name the field in `checkoutRequestSchema` that receives the referral code.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): R-16
- [bff-forwarder](bff-forwarder.md)
- [checkout-request-schema](checkout-request-schema.md)
- [post-checkout](post-checkout.md)
- [referral-code](referral-code.md)
<!-- used-by:end -->
