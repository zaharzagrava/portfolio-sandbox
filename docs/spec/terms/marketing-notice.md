---
id: marketing-notice
title: Marketing notice
kind: term
status: draft
aliases: [marketing notices]
defined_for: S28-notifications
rules_hash: 10d8beb4e09d
---
# Marketing notice
## Definition
A marketing notice is a promotional notification, as opposed to a [transactional one](transactional-send.md). It reaches its recipients through follower fan-out, which must be resumable and [idempotent ↗](../sw-external-terms.md#idempotency). Each recipient always gets an inbox item. External copies become marketing deliveries, which go on the [marketing lines](notification-line.md) and are subject to the [marketing delivery cap](marketing-delivery-cap.md). Those external channels are off by default in the preference matrix, so a recipient must opt in to get them.

## Example
A marketing notice fans out to a follower who opted in to marketing e-mail. The router creates the inbox item, checks the marketing cap and puts the e-mail on `notify-marketing-email`, not `notify-email`. If the cap is already reached, the delivery is recorded `capped` and the inbox item stays.

## Known gaps
- The spec does not say which event types or categories count as marketing notices, or which [source family](job-source.md) publishes them.
- The spec does not say who the "followers" are, for example the followers of a shop or of a user.
- Not confirmed in the code: the follower fan-out rule (S28.R-11) has `[proof: none]`.

## Used by
<!-- used-by:start -->
- [job-source](job-source.md)
- [marketing-delivery-cap](marketing-delivery-cap.md)
- [marketing-delivery](marketing-delivery.md)
- [notification-line](notification-line.md)
- [transactional-send](transactional-send.md)
<!-- used-by:end -->
