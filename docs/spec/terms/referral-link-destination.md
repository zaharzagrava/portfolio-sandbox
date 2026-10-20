---
id: referral-link-destination
title: Referral link destination
kind: term
status: draft
aliases: [destination, inside the marketplace, outside the marketplace]
defined_for: J05-engagement-loop
rules_hash: 3cbb4428e853
---
# Referral link destination
## Definition
The referral link destination is the page a referral link points to, chosen by the buyer when they create the link. It must be a destination inside the marketplace, such as a product. When creating a link, the [share-links capability](capability.md) checks the destination. A destination outside the marketplace is refused with destination_not_allowed, and no link is created. Refusing outside destinations keeps [short links](product-short-link.md) from sending people off the marketplace; this is design intent (not stated in the spec).

## Example
Buyer B creates a referral link whose destination is product P. The link is created, and friend F later follows the short link to P.
If B sets the destination to an outside site instead (illustrative: `https://example.org/deal`), the answer is `422 destination_not_allowed` and nothing is created.

## Known gaps
- The spec does not say which kinds of marketplace destination are allowed besides products, such as shops or boards.
- The spec does not say how a destination is judged to be inside the marketplace, for example by host, path or a known id.
- The spec does not say whether a link whose destination later becomes unavailable, such as an archived product, still resolves or is disabled.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
