---
id: journal-kind-reference
title: Journal kind and reference
kind: term
status: draft
aliases: [kind, reference]
defined_for: S14-ledger-reconciliation
rules_hash: 7fc5c396ccdc
---
# Journal kind and reference
## Definition
Each journal is identified by the pair ([kind](journal-kind.md), reference). The kind says what type of movement it is: `SALE`, `REFUND`, [`SETTLEMENT`](settlement-journal.md), [`SWEEP`](shard-sweep.md), `PAYOUT`, `PAYOUT_REVERSAL`, `AD_CHARGE` or [`ADJUSTMENT`](adjustment-journal.md). The reference is the business item it records. The store allows each pair only once. The journal's identifier is derived [deterministically ↗](../sw-external-terms.md#deterministic-build) from the pair (`journalId`), which makes repeated postings [idempotent ↗](../sw-external-terms.md#idempotency).

## Example
A retried [`recordPaymentCaptured`](record-payment-captured.md) for the same payment produces the same (`SALE`, reference) pair and therefore the same journal id. The call returns the existing journal with [`created: false`](enqueue-created-flag.md). (Using the payment id as the reference is illustrative.)

## Known gaps
- The spec does not say what value is used as the reference for each kind (for `SWEEP`, it only says one journal per account per window).
- The spec does not say how `journalId` is derived from the pair (which hash or format).

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-05
- [adjusted-resolution](adjusted-resolution.md)
- [adjustment-journal](adjustment-journal.md)
- [journal-conflict](journal-conflict.md)
- [journal-kind](journal-kind.md)
- [ledger-invariants](ledger-invariants.md)
- [ledger-journal](ledger-journal.md)
- [ledger-settle-order-job](ledger-settle-order-job.md)
- [ledger-store](ledger-store.md)
- [parse-statement-line](parse-statement-line.md)
- [post-journal](post-journal.md)
- [record-payment-captured](record-payment-captured.md)
<!-- used-by:end -->
