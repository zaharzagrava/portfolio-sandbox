---
id: checkout-attribution
title: Checkout attribution
kind: term
status: draft
aliases: [attribution]
defined_for: J05-engagement-loop
rules_hash: 0a5b66b6552d
---
# Checkout attribution
## Definition
`attribution` is the member of the checkout answer that reports whether the order was credited to a [referral link](referral-link.md). It is `null` when no [`ref`](checkout-ref.md) was sent, or when the `ref` was unknown, malformed, disabled or [self-owned](link-owner.md). Retries with the same [Idempotency-Key](idempotency-key.md) return one order carrying the first request's attribution. A later retry cannot change who gets the credit.

## Example
```json
{ "attribution": null }
```
Answer to B checking out with B's own [link code](referral-code.md) (status `202`; other answer members not shown).

## Known gaps
- The spec does not say the shape of `attribution` when it is not `null`.
- The spec does not say whether a retry with the same key and a different `ref` counts as "[another body](idempotency-key-reuse.md)"; per R-08 that would answer `422`.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
