---
id: feed-item
title: Feed item
kind: term
status: draft
aliases: [item]
defined_for: J05-engagement-loop
rules_hash: 1e66163b7686
---
# Feed item
## Definition
A [feed](follow-feed.md) item is one entry in a buyer's feed. It is created only by an event, never by a direct write from another domain. A product item comes from the product's event and appears once per product. [A `post` item](board-post.md) comes from a board post's event. The feed hides a product that is no longer [sellable](is-publicly-visible.md), and an older event must not bring it back. A [sandbox product](sandbox-product.md) or a [draft](onboarding-draft.md) (not [ACTIVE](product-lifecycle.md)) product never becomes a feed item.

## Example
A buyer follows shop S and the seller creates product P. The feed then holds P once (J05 AS-01). The seller archives P, and P is absent on the next read (J05 AS-04).

## [Known gaps](known-gaps.md)
- The spec does not say what fields a feed item carries, or how the feed is ordered and paginated beyond "first page".
- The spec does not name the item kind for products; only `post` is named.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
