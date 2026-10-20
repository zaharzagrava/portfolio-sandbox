---
id: discussion-events
title: Discussion events
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: 6e56451b71cb
---
# Discussion events
## Definition
Discussion events are the `discussion.*` events the discussion capability writes when a buyer creates a board post, comments, or deletes a post. They travel on the [`discussion.events` topic](discussion-events-topic.md) and are published through the [outbox](outbox-append.md), never by a direct send after the write. Other domains react to them instead of reading discussion tables. For example, a post reaches the [feeds](follow-feed.md) of its author's followers only through its event. A post to an unknown product is refused with [`board_not_found`](board-not-found.md) and emits no event.

## Example
B posts on product P's board. The post exists at once, and a `discussion.*` event lands on `discussion.events`. The feed side consumes it, and follower W's feed then holds one `post` item. If the discussion consumer is paused, W's feed lacks the item until resume.

## Known gaps
- The spec does not say the exact event type names (only the `discussion.*` pattern) or their payload fields.
- Not confirmed in the code: that `community-feed-discussions` is the consumer group reading `discussion.events`. The facts list both but do not link them.
- The spec does not say whether the `discussion.comment` notification is driven by a discussion event or by a direct call.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
