---
id: payouts-domain
title: Payouts capability
kind: term
status: draft
aliases: [payouts]
defined_for: J01-buy-to-payout
rules_hash: a8d37d2c428e
---
# Payouts capability
## Definition
The capability that pays sellers what they earned from sales. It runs the [payout run](payouts-run-weekly-job.md) and sends a [payout transfer](payout-transfer.md) to each shop's [payout destination](payout-destination.md). A shop below the [payout minimum](payout-minimum.md) gets no payout and keeps its balance. A rejected transfer ends the payout `FAILED` with a [failureCode](failure-code.md) and is [reversed in the books](reversing-journal.md). A re-run or overlapping run never creates a second payout for the same shop and week.

## Example
A shop's balance is above the minimum, its destination is set, and 49 hours have elapsed. The operator runs `payouts.run-weekly`. One payout ends `PAID`, and the owner holds one [`payout.paid` notice](payout-paid-event.md). A shop below the minimum gets no payout and shows `[blockedReason](blocked-reason.md): "below_minimum"`.

## Known gaps
- The spec does not say which capability id (`S10`, `S13`, `S15`, `S16` or `S28`) is the payouts capability.
- The spec does not say whether a `FAILED` payout is retried, or whether its amount returns in a later weekly run.
- The spec does not say what the 49 hours that must elapse before a payout is measured from.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
