---
id: referral-attribution
title: Referral attribution
kind: term
status: draft
aliases: [attributed]
defined_for: J05-engagement-loop
rules_hash: 2cc4bed95f23
---
# Referral attribution
## Definition
Referral attribution is the link between an order and the [share link](referral-link.md) that brought the buyer. Checkout accepts an optional [`ref`](checkout-ref.md), which carries the share reference, and the answer reports the resulting [`attribution`](checkout-attribution.md). An unknown, malformed, disabled or self-owned reference does not fail checkout; it answers [`202` ↗](../sw-external-terms.md#http-202-accepted) with `attribution: null`. Without `ref` on the order, clicking a link credits nobody. When checkout is retried with the same [Idempotency-Key](idempotency-key.md), the order keeps the first request's attribution.

## Example
Buyer B checks out with their own link's code, so the order is accepted but not attributed:
```json
{ "attribution": null }
```
Only the `attribution` member is shown here; the rest of the `202` body is not in the facts.

## Known gaps
- The spec does not say what a non-null `attribution` value contains.
- The spec does not say whether `ref` travels in the checkout body, the query string or a cookie.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
