---
id: ledger-posting
title: Ledger posting
kind: term
status: draft
aliases: [ledger entry]
defined_for: S13-payment-intents
rules_hash: e9d94b24f352
---
# Ledger posting
## Definition
A ledger posting is the accounting record saved to the system's money ledger when a payment becomes [`COMPLETED`](payment-status.md). It records that money was actually taken for the order. A [declined or failed payment](definite-decline.md) writes no posting. A completed refund writes a [reversing journal](reversing-journal.md) that cancels the original posting. Design intent (not stated in the spec): the ledger gives an auditable money trail that is separate from the payment's status.

## Example
The provider answers "succeeded" for the order's charge. The payment moves `PENDING → COMPLETED`, and one `LedgerEntry` posting is written for the order's amount, for example `2599 EUR` (illustrative).

## Known gaps
- The spec does not say what a posting contains (accounts, sign convention, fields).
- The spec does not say whether the posting is written in the same transaction as the status change and its history row.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): B-08
- [S14](../capabilities/S14-ledger-reconciliation.md): R-06, R-21, R-31, R-41, B-03, B-04
- [account-unknown](account-unknown.md)
- [adjusted-resolution](adjusted-resolution.md)
- [aggregate-rows](aggregate-rows.md)
- [authoritative-balance](authoritative-balance.md)
- [available-minor](available-minor.md)
- [balance-overflow](balance-overflow.md)
- [balance-row](balance-row.md)
- [catch-all-partition](catch-all-partition.md)
- [compare-rows](compare-rows.md)
- [definite-decline](definite-decline.md)
- [injected-clock](injected-clock.md)
- [ledger-busy](ledger-busy.md)
- [ledger-ensure-partitions](ledger-ensure-partitions.md)
- [ledger-entry-partition](ledger-entry-partition.md)
- [ledger-entry-table](ledger-entry-table.md)
- [ledger-lag-metric](ledger-lag-metric.md)
- [ledger-period](ledger-period.md)
- [logical-balance](logical-balance.md)
- [parse-account-id](parse-account-id.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [reversing-journal](reversing-journal.md)
- [running-balance](running-balance.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
