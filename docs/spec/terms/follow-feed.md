---
id: follow-feed
title: Follow feed
kind: term
status: draft
aliases: [feed]
defined_for: J05-engagement-loop
rules_hash: 042058527bb3
---
# Follow feed
## Definition
The follow feed is a buyer's personal list of items from the shops and buyers they follow. It is a [read model](read-model.md) built only from events, never by reading another domain's tables. A new [ACTIVE](product-lifecycle.md) product from a followed shop arrives through its [product event](catalog-product-events.md) as exactly one item. A post by a followed buyer arrives as a `post` item through its [discussion event](event-payload.md). Products that are no longer sellable are hidden, and deleted posts leave the feed at once.

## Example
Buyer follows shop S; the seller creates product P. The feed holds P once.
After the seller archives P, reading the feed again shows no P.
[Replaying](event-replay.md) [`products.events`](products-events-topic.md) and `feed.events` still leaves one item for P.

## Known gaps
- The spec does not say which route serves the feed or the page size of its first page.
- The spec does not say how the [consumer groups](consumer-group.md) `community-feed-products`, `community-feed-fanout` and `community-feed-discussions` split the work between them.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
