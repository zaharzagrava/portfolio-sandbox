---
id: product-board
title: Product board
kind: term
status: draft
aliases: [board]
defined_for: J05-engagement-loop
rules_hash: bcc22e0c6cd9
---
# Product board
## Definition
A product board is the discussion space attached to one product, where users write board posts and [board comments](board-comment.md). A board exists only for a known product. Posting to an unknown product is refused with [`board_not_found`](board-not-found.md), and [no event is emitted](event-payload.md). The board is owned by the [Discussion capability](discussion-consumer.md) (S25), not by the engagement journey.

## Example
Buyer B posts on product P's board, and the board lists the post. If B posts to a product id that does not exist, the answer is `404 board_not_found` and nothing reaches any [feed](follow-feed.md) (J05 AS-12).

## Known gaps
- The spec does not say whether a board is created with the product or on the first post.
- The spec does not say what happens to a board when its product is archived.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
