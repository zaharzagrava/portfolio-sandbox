---
id: ledger-journal-kinds
title: Ledger journal kinds (SALE, REFUND, SETTLEMENT, SWEEP)
kind: term
status: draft
aliases: [settlement, sweep]
defined_for: S14-ledger-reconciliation
rules_hash: 1588412d6054
---
# Ledger journal kinds (SALE, REFUND, SETTLEMENT, SWEEP)
## Definition
Every journal has a kind, and the pair (kind, reference) is unique and decides the journal's id. `SALE`, `REFUND`, `SETTLEMENT` and `SWEEP` are kinds that only [the ledger itself](ledger-service.md) posts. `SALE` comes from `recordPaymentCaptured`, `REFUND` from `[recordPaymentRefunded](record-payment-refunded.md)`, `SETTLEMENT` from the [settlement consumer](settlement-consumer.md) on [`order.paid`](order-paid-event.md), and `SWEEP` from the [hot-account sweep](shard-sweep.md). Callers of `postJournal` may use only `PAYOUT`, `PAYOUT_REVERSAL`, `AD_CHARGE` and `ADJUSTMENT`.

## Example
The payouts module calls `postJournal` with kind `SALE`. The call is refused and nothing is written. Payouts must use `PAYOUT` instead, and a sale can only enter the ledger through `recordPaymentCaptured`.

## Known gaps
- The spec does not name the refusal reason for a caller that posts a ledger-only kind.
- The spec does not say what reference each ledger-only kind uses, for example a payment id for `SALE` or a window for `SWEEP`.

## Used by
<!-- used-by:start -->
- [clawback](clawback.md)
- [journal-kind](journal-kind.md)
- [ledger-service](ledger-service.md)
- [settlement-consumer](settlement-consumer.md)
- [shard-sweep](shard-sweep.md)
<!-- used-by:end -->
