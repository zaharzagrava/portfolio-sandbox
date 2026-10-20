---
id: referral-code
title: Referral code
kind: term
status: draft
aliases: [referral data]
defined_for: W03-cart-checkout-orders
rules_hash: 14cb0512ce59
---
# Referral code
## Definition
A referral code is a value that travels in the [`__Host-ref` cookie](host-ref-cookie.md) and identifies where a buyer was referred from. Browser code never reads it. On a checkout request, the server adds the code itself. It does this only when [`checkoutRequestSchema`](checkout-request-schema.md) declares a field for it. Design intent (not stated in the spec): page scripts can't read or change a code they never see.

## Example
A member with a `__Host-ref` cookie presses **Place order** on the [Review step](checkout-review-step.md). The browser sends the order with no referral data in it. The server adds the referral code to the request only if `checkoutRequestSchema` declares the field (rule W03.R-16, proof W03 AS-34).

## Known gaps
- The spec does not say what sets the `__Host-ref` cookie or what a referral code looks like.
- The spec does not name the `checkoutRequestSchema` field that receives the code, or say whether that field is declared today.
- The spec does not say what the backend does with the referral code after checkout.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-47
- [checkout-request-schema](checkout-request-schema.md)
- [checkout-review-step](checkout-review-step.md)
- [host-ref-cookie](host-ref-cookie.md)
<!-- used-by:end -->
