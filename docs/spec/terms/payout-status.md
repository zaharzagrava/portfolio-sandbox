---
id: payout-status
title: Payout status
kind: term
status: draft
aliases: [failed, payout.failed]
defined_for: J01-buy-to-payout
rules_hash: e3b0c44298fc
---
# Payout status
## Definition
The status of one payout to a shop, moved by the [payouts capability](payouts-domain.md) and observed by the [buy-to-payout journey](main-journeys.md). The journey sees two end states: `PAID` when the transfer succeeds, and `FAILED` when the provider rejects it. A `FAILED` payout carries a [failureCode](failure-code.md) and is [reversed in the books](reversing-journal.md). The [payout run](payouts-run-weekly-job.md) creates at most one payout per shop and week, so a re-run never adds a second payout.

## Example
The operator runs `payouts.run-weekly` for a shop with a valid destination. The send job transfers the money, and the payout ends `PAID`. With a destination the provider rejects, the same run ends the payout `FAILED`, and the owner holds one `payout.failed` notice.

## Known gaps
- The spec does not say which statuses a payout has before the transfer is sent, or which transitions are legal.
- The spec does not say whether a `FAILED` payout is retried later or whether its amount returns to the next weekly run.

## Used by
<!-- used-by:start -->
- [failure-code](failure-code.md)
- [main-journeys](main-journeys.md)
- [payouts-domain](payouts-domain.md)
- [payouts-run-weekly-job](payouts-run-weekly-job.md)
- [reversing-journal](reversing-journal.md)
<!-- used-by:end -->
