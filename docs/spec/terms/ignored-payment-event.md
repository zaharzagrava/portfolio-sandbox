---
id: ignored-payment-event
title: IGNORED payment event
kind: term
status: draft
aliases: [ignored]
defined_for: S10-cart-checkout
rules_hash: e3b0c44298fc
---
# IGNORED payment event
## Definition
`IGNORED` is the status for a [stored payment event](payment-event-outcome.md) whose type the system does not handle. The event passed verification and is kept, but it changes no order. It differs from [`UNMATCHED`](unmatched-payment-event.md), where the order cannot be found, and from [`REJECTED`](rejected-payment-event.md), where status, amount or currency does not match the order. Design intent (not stated in the spec): storing unhandled types instead of failing them stops pointless retries. It also leaves a record if a type needs handling later.

## Example
A [verified webhook event](verified-webhook-event.md) arrives with a type the order flow does not handle, for example `"type": "customer.updated"` (illustrative). The webhook answers `200 {received: true}`, and processing then stores the event as `IGNORED`.

## Known gaps
- The spec does not list which event types are handled. It names `payment_succeeded`, `payment_failed`, `payment_refunded` and a full `charge.refunded`, but does not say the list is complete.
- The spec does not say whether a late `payment_failed` after [`PAID`](order-status.md) is stored as `IGNORED` or under another status. The rule only says it "MUST be ignored".
- The spec does not say whether `IGNORED` events can be processed again if support for their type is added later.

## Used by
<!-- used-by:start -->
- [payment-event-outcome](payment-event-outcome.md)
- [verified-webhook-event](verified-webhook-event.md)
<!-- used-by:end -->
