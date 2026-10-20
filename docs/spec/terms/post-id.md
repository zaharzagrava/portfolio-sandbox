---
id: post-id
title: postId
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: e3b0c44298fc
---
# postId
## Definition
`postId` is the identifier of a post created on a product's [discussion board](product-board.md). The [create-post](board-post.md) answer returns it. Retrying the same create with the same [`Idempotency-Key`](idempotency-key.md) returns the same `postId` instead of creating a second post. The same key with a different body answers `422`.

## Example
Buyer B sends the same create-post request five times at once with one `Idempotency-Key`. All five answers are `2xx` and carry one identical `postId`; the board lists one post.

## [Known gaps](known-gaps.md)
- The spec does not say the format of `postId` or the create-post route.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
