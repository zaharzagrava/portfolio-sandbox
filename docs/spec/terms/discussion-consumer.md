---
id: discussion-consumer
title: Discussion consumer
kind: term
status: draft
aliases: [consumer]
defined_for: J05-engagement-loop
rules_hash: 070d3ef8d5d7
---
# Discussion consumer
## Definition
The discussion consumer reads [discussion events](discussion-events.md) and places posts into the [feeds](follow-feed.md) of the author's followers. It runs separately from the post write, so pausing it never blocks or delays creating a post. While it is paused, the post exists on the board but followers' feeds lack it; after resume the item appears once. Like every consumer here, it is [idempotent ↗](../sw-external-terms.md#idempotency) and discards events older than the [applied state](applied-state.md).

## Example
The operator pauses the discussion consumer through the [control surface](control-surface.md). B posts on a product board: the post exists at once. Follower W's feed lacks it until the consumer is resumed.

## Known gaps
- Not confirmed in the code: that this consumer is the consumer group `community-feed-discussions`; the facts list the group but do not map it to this name.
- The spec does not say how a deleted post leaves feeds "at once" if this consumer is paused.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
