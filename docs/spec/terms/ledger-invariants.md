---
id: ledger-invariants
title: Ledger invariants
kind: term
status: draft
aliases: [invariant]
defined_for: S14-ledger-reconciliation
rules_hash: 38475b41e1c3
---
# Ledger invariants
## Definition
The ledger invariants are the properties that must hold for every [journal](ledger-journal.md) the ledger stores. Every journal is [balanced](balanced-journal.md) and has one currency and whole [minor-unit](minor-units.md) amounts. Entries and journal headers are [append-only ↗](../sw-external-terms.md#append-only). Each [(kind, reference)](journal-kind-reference.md) pair appears only once. [Guarded accounts](no-negative-guard.md) never go below zero. The ledger store enforces the balance, append-only and uniqueness invariants itself, whoever does the writing. The posting code also checks them before writing. A separate [`ledger.verify-invariants`](ledger-verify-invariants.md) job is listed among the ledger's jobs.

## Example
A `SALE` for a capture of 10000 minor units (illustrative), with the default fee of 50:
```
PROVIDER_CLEARING     -10000
MARKETPLACE_CLEARING   +9950
PLATFORM_FEES            +50   → sum = 0, balanced
```
If you change `+9950` to `+9960`, the posting is refused with a named reason, and nothing is written.

## Known gaps
- The spec does not say what `ledger.verify-invariants` checks, how often it runs, or what happens when it finds a violation.
- The spec does not say whether stored running balances are ever compared against the sum of entries. Balances are never computed that way at read time.

## Used by
<!-- used-by:start -->
- [balanced-journal](balanced-journal.md)
- [journal-kind-reference](journal-kind-reference.md)
- [ledger-jobs](ledger-jobs.md)
- [ledger-journal](ledger-journal.md)
- [ledger-store](ledger-store.md)
- [ledger-verify-invariants](ledger-verify-invariants.md)
- [minor-units](minor-units.md)
- [no-negative-guard](no-negative-guard.md)
<!-- used-by:end -->
