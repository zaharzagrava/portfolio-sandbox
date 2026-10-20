---
id: link-converted-event
title: link.converted event
kind: term
status: draft
aliases: [link.converted]
defined_for: J05-engagement-loop
rules_hash: e3b0c44298fc
---
# link.converted event
## Definition
`link.converted` is the event the [share links capability](referral-link.md) (S37) emits when an [attributed paid order](attributed-order.md) credits a [link owner](link-owner.md) with a [conversion](conversion.md). It follows the conversion rules: exactly one conversion per attributed paid order, even under a duplicate or late [`order.paid`](order-paid-event.md). It must not expose the buyer's identity to the link owner.

## Example
Buyer B shares a link. Anonymous friend F checks out with [`ref`](order-ref.md) set to B's code and pays. The [`marketing-affiliate-conversions`](conversion-consumer.md) consumer credits B one conversion, and `link.converted` reports it without any field that identifies F.

## Known gaps
- The spec does not say which topic carries `link.converted`, its payload members, or who consumes it.
- The spec does not say whether a [reversal by full refund](conversion-reversal.md) emits a separate event.
- Not confirmed in the code: the privacy inspection of logs (AS-36) has a test id, but its detail is not in the facts.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
