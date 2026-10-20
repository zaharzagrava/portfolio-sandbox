---
id: live-events-topic
title: live.events topic
kind: term
status: draft
aliases: [live.events]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# live.events topic
## Definition
`live.events` is the topic that carries the facts of a live stream from the [live domain](live-domain.md) to its consumers. The [launch-day journey](launch-day-flow.md) reads it but does not own it. The [`live-comments-history` consumer group](consumer-group.md) reads it to fill [chat history](chat-history.md). Stream start and end and comments must produce no [inbox item](inbox-item.md), and [replaying the topic](event-replay.md) must leave inboxes unchanged. A paused consumer of the topic must lose nothing, and after resume each fact applies once.

## Example
A brand goes live, and a viewer posts a comment (comment text and `clientId` illustrative). The comment travels on `live.events`, and `live-comments-history` stores it in chat history. No `notification-router` inbox item appears for it.

## Known gaps
- The spec does not say which event names travel on `live.events`. The facts list none, though they describe comments, pins, removals, stream start and stream end.
- The spec does not say whether `notification-router` subscribes to `live.events`. It only says these facts produce no inbox item.
- The spec does not say which domain writes the topic. Not confirmed in the code: the topic's producer.

## Used by
<!-- used-by:start -->
- [chat-history](chat-history.md)
- [consumer-group](consumer-group.md)
- [event-replay](event-replay.md)
- [inbox-item](inbox-item.md)
- [launch-day-flow](launch-day-flow.md)
- [live-domain](live-domain.md)
<!-- used-by:end -->
