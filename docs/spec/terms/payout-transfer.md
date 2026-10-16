---
id: payout-transfer
title: Payout transfer
kind: term
status: draft
aliases: [transfer]
defined_for: J01-buy-to-payout
rules_hash: 4b1c4d678e3d
---
# Payout transfer
## Definition
A payout transfer is the request to the [payment provider](payment-provider.md) that moves a payout's money to the shop's payout destination. A payout has at most one transfer, so a re-run or overlapping [payout run](payouts-run-weekly-job.md) sends no second transfer. If the provider rejects the transfer, the payout ends `FAILED` with a `failureCode` and is [reversed in the books](reversing-journal.md). A successful transfer leads to [`payout.paid`](payout-paid-event.md), and a rejected one leads to `payout.failed`. Both notices go to the shop owners.

## Example
J01.B-12: `payouts.run-weekly` is requested twice at once. Both jobs end `SUCCEEDED`, and only one transfer and one `payout.paid` notice exist.
J01.B-13: the provider rejects the destination, so the payout is `FAILED`, the books are reversed and the owner holds one `payout.failed`.

## Known gaps
- The spec does not name the job that sends the transfer. It only says "the run and send job execute".
- The spec does not say how duplicate transfers are prevented at the provider, for example whether a provider idempotency reference is used.
- The spec does not say whether a failed transfer is ever retried, or whether the balance becomes payable again after the reversal.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
