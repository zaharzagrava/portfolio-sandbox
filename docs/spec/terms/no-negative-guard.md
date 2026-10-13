---
id: no-negative-guard
title: No-negative guard
kind: term
status: draft
aliases: [no-negative guard on `payout` journals]
defined_for: S14-ledger-reconciliation
rules_hash: 2dbf84d72419
---
# No-negative guard
## Definition
The no-negative guard is a check that refuses a posting if it would push a [guarded account](guarded-account.md)'s [running balance](running-balance.md) below zero. It covers a `PAYOUT` journal that debits a seller account, and any line on [`PAYOUT_CLEARING`](ledger-system-accounts.md). The check happens [atomically ↗](../sw-external-terms.md#atomicity) with the balance update, so concurrent postings cannot both pass it. A refused posting fails with `insufficient_balance` and nothing is written. Other journal kinds may take a seller account negative, such as a `REFUND` that claws back a settled share.

## Example
Shop `SHOP_<uuid>` has a running balance of 3,000 minor units (illustrative). A `PAYOUT` journal debits that shop by 5,000. It is refused with `insufficient_balance`.
A `REFUND` that claws back 5,000 from the same shop is accepted, and the shop's `availableMinor` becomes -2,000.

## Known gaps
- The spec does not say how the guard is enforced inside the store, for example a conditional update or a row check. It only says the decision is atomic with the balance update. The code entry point is `packages/backend/libs/domains/payments/domain/account.ts#isGuarded`.
- The spec does not say why only these accounts are guarded. Stopping the platform from sending out money a seller does not hold is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [guarded-account](guarded-account.md)
- [journal-kind](journal-kind.md)
- [ledger-invariants](ledger-invariants.md)
- [payout-clearing](payout-clearing.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
