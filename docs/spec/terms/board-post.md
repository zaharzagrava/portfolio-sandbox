---
id: board-post
title: Board post
kind: term
status: draft
aliases: [post, posts]
defined_for: J05-engagement-loop
rules_hash: 8b79429a0a5d
---
# Board post
## Definition
A board post is a message a user writes on a [product board](product-board.md). Creating one writes a [`discussion.*` event](discussion-comment-notification.md). That event, and nothing else, carries the post into the [feeds](follow-feed.md) of the author's followers through [follower fan-out](follower-fan-out.md). Creating a post is safe to retry with the same [`Idempotency-Key`](idempotency-key.md). When the post is deleted, it leaves every feed at once, and a late event cannot bring it back.

## Example
Follower W follows buyer B, and B posts on product P's board, so W's feed holds one `post` item (J05 AS-07). B sends the same post five times at once with one key, and every answer is `2xx` with one `postId` (J05 AS-08).

## Known gaps
- The spec does not give the exact event names behind `discussion.*` or the post's fields.
- Not confirmed in the code: that `community-feed-discussions` is the consumer group doing this fan-out. Its name suggests it, but the facts do not say so.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
