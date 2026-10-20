---
id: board-comment
title: Board comment
kind: term
status: draft
aliases: [comment]
defined_for: J05-engagement-loop
rules_hash: 07c1c7835d0f
---
# Board comment
## Definition
A board comment is a reply to a board post on a product board. Writing one emits a [`discussion.*` event](discussion-comment-notification.md). That event triggers a [notification](notification.md) to the post's author: once, and never to the commenter. Creating a comment is [safe to retry ↗](../sw-external-terms.md#idempotency) with the same [`Idempotency-Key`](idempotency-key.md). The same key sent with a different body answers [`422` ↗](../sw-external-terms.md#http-422-unprocessable-content).

## Example
The seller comments on buyer B's post. When B reads notifications, there is exactly one `discussion.comment` item (J05 AS-09).

## Known gaps
- The spec does not say whether comments appear in followers' feeds the way posts do.
- The spec does not say what happens to a post's comments when the post is deleted.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
