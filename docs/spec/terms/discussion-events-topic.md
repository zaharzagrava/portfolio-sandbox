---
id: discussion-events-topic
title: discussion.events topic
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: ce41d1c4f2a1
---
# discussion.events topic
## Definition
The `discussion.events` topic is the event stream that carries the discussion capability's discussion events. A board post, a [board comment](board-comment.md) and a post deletion each write a `discussion.*` event, published through [the outbox](outbox-append.md). Other domains, such as the [follow feed](follow-feed.md), consume this topic instead of reading discussion tables. The engagement journey reads it but does not own it. A post to an unknown product answers [`board_not_found`](board-not-found.md) and puts nothing on the topic.

## Example
Buyer B posts on product P's product board. The post exists at once, and its event reaches `discussion.events`. The feed consumer then adds one `post` item to follower W's feed. If the discussion consumer is paused, W's feed lacks the item until resume, and the consumer lag shows the backlog.

## Known gaps
- The spec does not say the exact event type names (only the `discussion.*` pattern) or their payload fields.
- Not confirmed in the code: that `community-feed-discussions` is the consumer group reading `discussion.events`. The facts list both but never link them.
- The spec does not say whether the `discussion.comment` notification comes from this topic or from another path.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
