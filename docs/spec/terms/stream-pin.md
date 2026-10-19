---
id: stream-pin
title: Stream pin
kind: term
status: draft
aliases: [pinned product]
defined_for: J03-launch-day
rules_hash: f7f32e674a74
---
# Stream pin
## Definition
A stream pin is a live-stream event that highlights an item for everyone watching. Viewers receive it through the stream's [event stream](stream-connection.md), together with comments and removals. It is a hand-off from the [live domain](live-domain.md) to connected viewers, and it is not a stored order or booking.

## Example
The brand starts a stream and pins a message. Each connected viewer receives the pin event on their stream connection. When the brand ends the stream, the connection closes.

## Known gaps
- The spec does not say what can be pinned (a comment or free text), or who may pin.
- The spec does not say whether a pin creates an [inbox item](inbox-item.md). The [no-notification list](no-notification-list.md) in J03.R-16 names stream start and end, and comments, but not pins.
- The spec does not say whether a new pin replaces an earlier one, or whether late joiners see the current pin.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): B-19
- [live-stream](live-stream.md)
<!-- used-by:end -->
