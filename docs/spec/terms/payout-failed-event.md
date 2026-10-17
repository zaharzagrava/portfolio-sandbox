---
id: payout-failed-event
title: payout.failed event
kind: term
status: draft
aliases: [payout.failed]
defined_for: J01-buy-to-payout
rules_hash: e3b0c44298fc
---
# payout.failed event
## Definition
The event that says a payout to a shop ended `FAILED`, because the provider rejected the transfer. It travels on the [event backbone](event-backbone.md) through the [outbox task queue](task-row.md). The notifications side consumes it and sends one `payout.failed` notice to the shop's owners. By the time of this outcome, the payout carries a [failureCode](failure-code.md) and is [reversed in the books](reversing-journal.md).

## Example
A shop's [destination](payout-destination.md) is rejected by the provider. The run and send job execute, the payout ends `FAILED`, the books are reversed, and the owner holds one `payout.failed` notice.

## Known gaps
- The spec does not say which topic carries `payout.failed` or whether its payload includes the failureCode.
- The spec does not say whether the event is published in the same transaction as the reversal in the books.

## Used by
<!-- used-by:start -->
- [event-backbone](event-backbone.md)
- [failure-code](failure-code.md)
- [payout-destination](payout-destination.md)
- [reversing-journal](reversing-journal.md)
- [task-row](task-row.md)
<!-- used-by:end -->
