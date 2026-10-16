---
id: payout-destination
title: Payout destination
kind: term
status: draft
aliases: [destination]
defined_for: J01-buy-to-payout
rules_hash: 2813b2c7efad
---
# Payout destination
## Definition
A [payout](payout-transfer.md) destination is the place a shop's payout is sent to by the payment provider. A shop needs a destination set before [the weekly run](payouts-run-weekly-job.md) can pay it. If the provider rejects the destination, the payout ends [`FAILED`](payout-status.md) with a [`failureCode`](failure-code.md). [The books are then reversed](reversing-journal.md) and the owners receive a [`payout.failed`](payout-failed-event.md) notice.

## Example
J01.B-11: a shop has a balance above the [minimum](payout-minimum.md) and a destination set. The [operator](operator.md) runs `payouts.run-weekly`, and one payout is paid.
J01.B-13: a destination the provider rejects leads to a `FAILED` payout, reversed books and one `payout.failed` notice for the owner.

## Known gaps
- The spec does not say how a destination is set or changed, who may set it, or what data it holds.
- The spec does not say what the payout run does for a shop with no destination set, or whether it reports a [`blockedReason`](blocked-reason.md) for that case.
- The spec does not list the `failureCode` values a rejected destination can produce.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): B-11
- [blocked-reason](blocked-reason.md)
- [failure-code](failure-code.md)
- [payout-failed-event](payout-failed-event.md)
- [payout-paid-event](payout-paid-event.md)
- [payouts-domain](payouts-domain.md)
<!-- used-by:end -->
