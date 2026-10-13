---
id: journal-kind
title: Journal kind
kind: term
status: draft
aliases: [ad_charge, adjustment, payout, payout_reversal, sale, settlement, sweep]
defined_for: S14-ledger-reconciliation
rules_hash: 6999db7a8e79
---
# Journal kind
## Definition
A journal kind is the business category of a journal, for example `SALE` or `PAYOUT`. The kind sets who may post the journal. `SALE`, `REFUND`, `SETTLEMENT` and `SWEEP` are [posted only by the ledger](ledger-journal-kinds.md). `PAYOUT`, `PAYOUT_REVERSAL`, `AD_CHARGE` and `ADJUSTMENT` come from callers through `postJournal`. The kind is part of the journal's uniqueness key (kind, reference) and its [deterministic identifier ↗](../sw-external-terms.md#deterministic-build). Some rules depend on the kind, such as the [no-negative guard](no-negative-guard.md) on `PAYOUT` journals.

## Example
`recordPaymentCaptured` posts kind `SALE` with the payment as its reference. A second identical call returns that same journal with [`created: false`](enqueue-created-flag.md). A `REFUND` for the same payment is a separate journal because its kind is different.

## Known gaps
- The spec does not describe what `PAYOUT_REVERSAL`, `AD_CHARGE` or `ADJUSTMENT` journals must contain, beyond the general journal rules.

## Used by
<!-- used-by:start -->
- [catch-all-partition](catch-all-partition.md)
- [clawback](clawback.md)
- [insufficient-balance](insufficient-balance.md)
- [journal-kind-reference](journal-kind-reference.md)
- [ledger-journal-kinds](ledger-journal-kinds.md)
- [ledger-journal](ledger-journal.md)
- [ledger](ledger.md)
- [logical-balance](logical-balance.md)
- [no-negative-guard](no-negative-guard.md)
- [payer-id](payer-id.md)
- [payment-capture](payment-capture.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [platform-fee](platform-fee.md)
- [post-journal](post-journal.md)
- [posted-at](posted-at.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [record-payment-captured](record-payment-captured.md)
- [record-payment-refunded](record-payment-refunded.md)
- [settled-sale](settled-sale.md)
- [shop-account](shop-account.md)
- [statement-line-matching](statement-line-matching.md)
- [uncovered-month](uncovered-month.md)
<!-- used-by:end -->
