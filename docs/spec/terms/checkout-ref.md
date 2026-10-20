---
id: checkout-ref
title: ref (checkout reference)
kind: term
status: draft
aliases: [ref, reference]
defined_for: J05-engagement-loop
rules_hash: e3b0c44298fc
---
# ref (checkout reference)
## Definition
`ref` is an optional input on [checkout](post-checkout.md) that carries the code of a [referral link](referral-link.md). Checkout uses it to decide whether the new order is [attributed to the link owner](attributed-order.md). A code that is unknown, malformed, disabled, or owned by the buyer is not an error: checkout still answers [`202`](reserved-answer.md), with [`attribution: null`](checkout-attribution.md). Rejecting self-owned codes stops buyers from crediting themselves (design intent (not stated in the spec)).

## Example
F checks out with B's link code as `ref` → the order is attributed to B.
B checks out with B's own code → `202` with `attribution: null`, and B gets no new [conversion](conversion.md).

## Known gaps
- The spec does not say whether `ref` travels in the request body or the query string, or what a well-formed code looks like.
- The spec does not say which of the four rejection reasons applied; the answer is the same `attribution: null` for all.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
