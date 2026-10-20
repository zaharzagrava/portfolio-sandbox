---
id: referral-link
title: Referral link
kind: term
status: draft
aliases: [link]
defined_for: J05-engagement-loop
rules_hash: c4fcd11e6062
---
# Referral link
## Definition
A referral link is a share link a buyer creates for a [marketplace destination](referral-link-destination.md), such as a product, and passes on to friends. It carries a [short code](referral-code.md) that a friend can bring to checkout as [`ref`](checkout-ref.md), so the [link owner](link-owner.md) can be credited. Share links belong to the [share-links capability](capability.md), which also serves the short link and the owner's stats and conversions. Creating a link is safe to retry with the same [Idempotency-Key](idempotency-key.md). A destination outside the marketplace is refused and nothing is created.

## Example
Buyer B creates a link to product P. Anonymous friend F follows the short link, checks out with its code as `ref`, and pays. B then has one conversion.
If B instead points the link at an outside site, the answer is `422 destination_not_allowed`.

## Known gaps
- The spec does not say the routes for creating a link, following the short link, or reading stats and conversions.
- The spec does not say which destinations count as "inside the marketplace" beyond products.
- The spec does not say how a link becomes disabled, though a disabled link's code is not credited at checkout.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
