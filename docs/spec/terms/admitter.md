---
id: admitter
title: Admitter
kind: term
status: draft
aliases: []
defined_for: J03-launch-day
rules_hash: 1a87cdc8d658
---
# Admitter
## Definition
The admitter is the step that lets queued buyers into a [launch event](launch-event.md)'s sale. When sales are open and it runs, buyers waiting in the [buyer queue](buyer-queue.md) receive tickets, meaning [admission tokens](admission-token.md). Each token is bound to one event and one buyer. Buyers then use the token to [hold seats](seat-hold.md) and confirm.

## Example
There are 12 buyers in the queue of a launch event that is [`ON_SALE`](launch-event-status.md). The admitter runs, and each buyer gets an admission token. Each buyer then holds seats on the hold route and confirms the hold (J03.B-01).

## Known gaps
- The spec does not say whether the admitter is a job, a [consumer](event-consumer.md) or part of a request.
- The spec does not say how often it runs or how many buyers it admits in each run.
- The spec does not say whether an admission token expires.

## Used by
<!-- used-by:start -->
- [J03](../capabilities/J03-launch-day.md): B-01
- [admission-token](admission-token.md)
- [buyer-queue](buyer-queue.md)
- [event-consumer](event-consumer.md)
- [launch-event](launch-event.md)
- [seat-hold](seat-hold.md)
<!-- used-by:end -->
