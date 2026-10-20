---
id: invalid-event
title: Invalid event
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: 465a8f502ae8
---
# Invalid event
## Definition
An invalid event is an incoming analytics or storefront event that fails validation. [Trending](trending-aggregate.md) must not let it change any [trending score](trending-score.md). Instead, it is reported back in the [`rejected`](rejected-members.md) member (J05.R-17). Duplicates are a separate case: an event whose [event id](event-id.md) was already seen is also ignored, but it is not reported as invalid.

## Example
Illustrative: a [batch](bounded-batch.md) carries a valid view of P, a valid [add-to-cart](add-to-cart-signal.md) of Q, and a malformed event. Trending counts only P's view and Q's add-to-cart. The malformed event is listed in `rejected`.

## Known gaps
- The spec does not say what makes an event invalid, for example a missing field, an unknown type, or a bad timestamp.
- The spec does not say whether the valid events in the same request are still applied.
- The spec does not name the endpoint that receives these events.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
