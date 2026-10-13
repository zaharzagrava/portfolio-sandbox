---
id: decide-payment-status
title: decide (payment status decision)
kind: term
status: draft
aliases: [decide]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# decide (payment status decision)
## Definition
`decide` is the function in `domain/payment-status.ts` that S13.R-20 links as the code for payment status changes. S13.R-20 says every change is one [guarded update](guarded-update.md) on status and version, writes one [history row](payment-status-history.md), and steps the version once. A [terminal payment status](terminal-payment-status.md) is never revisited. The [charge processor](payment-processor.md), [unknown payment resolution](unknown-payment-resolution.md), order events and the [refund worker](refund.md) all move payments between statuses, and S13.R-20 covers all of those moves.

## Example
A payment is `UNKNOWN` after a provider timeout. Unknown payment resolution looks it up and finds a succeeded provider intent. The payment moves `UNKNOWN` → `COMPLETED` through the same guarded step as a direct success: one guarded update, one history row, and the version goes from 3 to 4 (illustrative values) (S13.B-12).

## Known gaps
- Not confirmed in the code: which callers use `decide`, or whether every status change goes through it. The facts link it to S13.R-20 but do not show its callers.
- The spec does not say what `decide` does with a transition that is not allowed, for example whether it throws [`invalid_transition`](invalid-transition.md) or just skips the change.
- The spec does not list the full table of allowed transitions on this page. It points to the payment-status model page, which is not in the facts.

## Used by
<!-- used-by:start -->
- [guarded-update](guarded-update.md)
- [payment-processor](payment-processor.md)
- [payment-status-history](payment-status-history.md)
- [refund](refund.md)
- [terminal-payment-status](terminal-payment-status.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
