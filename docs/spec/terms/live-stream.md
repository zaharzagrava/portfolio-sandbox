---
id: live-stream
title: Live stream
kind: term
status: draft
aliases: [stream end, stream start]
defined_for: J03-launch-day
rules_hash: 9b8b11c6e768
---
# Live stream
## Definition
A live stream is the brand's broadcast during a [launch day](launch-day-flow.md), where the audience watches and chats. The brand starts and ends it. Viewers get its start, comments, [pins](stream-pin.md), removals and end through an [event stream](stream-connection.md). The connection closes when the stream ends. By decision, starting and ending a stream produce no [inbox item](inbox-item.md).

## Example
The brand starts a stream. Viewers receive the start event and then the posted comments, which `live-comments-history` also stores. The brand ends the stream, viewers receive the end event, and their connections close. No [`notification-router`](notification-router.md) inbox item is created for the start or the end.

## Known gaps
- The facts name no route for starting, ending or joining a stream.
- The spec does not list the stream's lifecycle states, and it does not say who besides the brand may end a stream.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): B-19
- [client-id-reused](client-id-reused.md)
- [comment-moderation](comment-moderation.md)
- [inbox-item](inbox-item.md)
- [launch-day-flow](launch-day-flow.md)
- [recent-comments](recent-comments.md)
- [stream-connection](stream-connection.md)
- [stream-pin](stream-pin.md)
<!-- used-by:end -->
