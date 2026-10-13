---
id: ledger-journal
title: Journal (ledger)
kind: term
status: draft
aliases: [journals]
defined_for: S14-ledger-reconciliation
rules_hash: 8d80a7af6f65
---
# Journal (ledger)
## Definition
A journal is one [balanced](balanced-journal.md), [immutable ↗](../sw-external-terms.md#immutable) record of a money movement, posted once. It holds lines, and each line moves a non-zero whole-[minor-unit](minor-units.md) amount on one [account](ledger-account.md). All lines share one currency and one [`postedAt`](posted-at.md), and their amounts sum to exactly zero. Each journal has a [kind](journal-kind.md) and a [reference](journal-kind-reference.md). A mistake is never edited; it is corrected with a new [reversing journal](reversing-journal.md).

## Example
[`recordPaymentCaptured`](record-payment-captured.md) for a capture of 1000 minor units (amount illustrative, fee at its default of 50) posts one [`SALE`](journal-kind.md) journal:
```
[PROVIDER_CLEARING](ledger-system-accounts.md)     -1000
[MARKETPLACE_CLEARING](ledger-system-accounts.md)   +950
[PLATFORM_FEES](ledger-system-accounts.md)           +50
```

## Known gaps
- The spec does not say which named reasons `validateJournal` gives for each kind of refused journal.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-01, R-12, R-24, R-30
- [adjusted-resolution](adjusted-resolution.md)
- [balanced-journal](balanced-journal.md)
- [injected-clock](injected-clock.md)
- [issue](issue.md)
- [journal-kind-reference](journal-kind-reference.md)
- [journal-kind](journal-kind.md)
- [journal-unbalanced](journal-unbalanced.md)
- [ledger-account](ledger-account.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
- [ledger-events-topic](ledger-events-topic.md)
- [ledger-invariants](ledger-invariants.md)
- [ledger-period](ledger-period.md)
- [ledger-store](ledger-store.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [ledger-verify-invariants](ledger-verify-invariants.md)
- [ledger](ledger.md)
- [minor-units](minor-units.md)
- [orm-association](orm-association.md)
- [payer-id](payer-id.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [posted-at](posted-at.md)
- [provider-statement](provider-statement.md)
- [rebuildable-read-model](rebuildable-read-model.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-reference](reconciliation-issue-reference.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation](reconciliation.md)
- [record-payment-refunded](record-payment-refunded.md)
- [reversing-journal](reversing-journal.md)
- [shop-account](shop-account.md)
- [uncovered-month](uncovered-month.md)
<!-- used-by:end -->
