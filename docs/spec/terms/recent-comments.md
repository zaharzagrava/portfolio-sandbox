---
id: recent-comments
title: Recent comments
kind: term
status: draft
aliases: [history]
defined_for: J03-launch-day
rules_hash: 4fca5d2853ca
---
# Recent comments
## Definition
Recent comments are the latest comments of a [live stream](live-stream.md), kept so that a viewer who joins late can see what was already said. This list is separate from the [stored comment history](chat-history.md), which the [`live-comments-history` consumer group](consumer-group.md) writes. Removed or moderated comments never appear in recent comments.

## Example
A viewer posts a comment, and a second viewer joins the stream afterwards. The late joiner sees that comment among the recent comments, and history stores it as well (J03.B-18).

## Known gaps
- The spec does not say how many comments the recent list keeps, or how it is served ([stream replay](event-replay.md) or a separate read).

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): R-19
- [chat-history](chat-history.md)
- [comment-moderation](comment-moderation.md)
- [consumer-group](consumer-group.md)
- [event-replay](event-replay.md)
- [live-stream](live-stream.md)
<!-- used-by:end -->
