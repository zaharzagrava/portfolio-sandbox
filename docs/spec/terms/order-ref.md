---
id: order-ref
title: ref (order referral code)
kind: term
status: draft
aliases: [ref]
defined_for: J05-engagement-loop
rules_hash: e3b0c44298fc
---
# ref (order referral code)
## Definition
This is the [referral code](referral-code.md) an order keeps from the [`ref`](checkout-ref.md) accepted at checkout. [Referral credit](referral-credit.md) is decided only by this value on the order. Having clicked a link earlier does not count. Deciding at checkout keeps [attribution](checkout-attribution.md) explicit and one-per-order (design intent (not stated in the spec)).

## Example
F follows B's [short link](product-short-link.md) but checks out without `ref` → no [conversion](conversion.md) for B.
F checks out with B's code as `ref` and pays → B is credited once.

## Known gaps
- The spec does not say whether an order keeps a rejected `ref` (one that yielded `attribution: null`).
- The spec does not say whether the order's `ref` appears in [`order.paid`](order-paid-event.md) or how the [conversion consumer](conversion-consumer.md) reads it.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
