---
id: live-domain
title: Live domain
kind: term
status: draft
aliases: [live]
defined_for: J03-launch-day
rules_hash: 76a5ae3f3a66
---
# Live domain
## Definition
The live domain is the part of the system that runs a brand's live stream. The brand starts and ends a stream, and the audience posts comments while it runs. Viewers receive comments, pins and removals through an [event stream ↗](../sw-external-terms.md#server-sent-events) on their [stream connection](stream-connection.md). The domain publishes its facts on the `live.events` topic, and the [consumer group](consumer-group.md) `live-comments-history` stores comments in history. In the launch-day journey it hands off only to viewers and to history. Stream start, stream end and comments create no [inbox item](inbox-item.md).

## Example
The brand starts a stream. A viewer posts a comment with a `clientId`. Other viewers receive it, a late joiner sees it in recent comments, and `live-comments-history` stores it. When the brand ends the stream, every viewer's connection closes.

## Known gaps
- The spec does not say which capability page (S-number) owns the live domain. The J03 page lists the domains only as placeholders.
- The spec does not say whether stream pins create an inbox item. J03.R-16 lists stream start, stream end and comments, but not pins.
- The facts list no routes for starting or ending a stream, posting a comment or opening the event stream.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
