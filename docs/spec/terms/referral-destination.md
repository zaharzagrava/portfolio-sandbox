---
id: referral-destination
title: Referral link destination
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: f42d97c371c3
---
# Referral link destination
## Definition
A [referral link destination](referral-link-destination.md) is the marketplace page a [share link](referral-link.md) sends people to when they follow its [short link](product-short-link.md). The [owner](link-owner.md) chooses it when creating the link. It must lie inside the marketplace; any other destination is refused with [destination_not_allowed](destination-not-allowed.md). Keeping links from redirecting to outside sites is design intent (not stated in the spec).

## Example
B creates a link whose destination is a marketplace product page, such as a product short link (illustrative choice). Anonymous F follows the short link, lands on that page and later checks out with the [code](referral-code.md).

## Known gaps
- The spec does not say which marketplace pages count as allowed destinations.
- The spec does not say whether a link's destination can be changed after the link is created.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
