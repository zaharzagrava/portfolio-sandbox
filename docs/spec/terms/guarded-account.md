---
id: guarded-account
title: Guarded account
kind: term
status: draft
aliases: [guarded]
defined_for: S14-ledger-reconciliation
rules_hash: ad28cc8a4420
---
# Guarded account
## Definition
A guarded account is a [ledger account](ledger-account.md) whose [running balance](running-balance.md) must not go below zero for a given posting. The no-negative guard checks only these accounts. Being guarded depends on both the account and the journal kind. [`PAYOUT_CLEARING`](payout-clearing.md) is guarded on any line of any journal. A seller account is guarded only when a [`PAYOUT` journal](payout-journal.md) debits it. With every other journal kind, a seller account is not guarded and its balance may go negative.

## Example
Shop account `SHOP_<uuid>` has a running balance of 3,000 [minor units](minor-units.md) (illustrative). A `PAYOUT` journal that debits it by 5,000 hits a guarded account, so it is refused with `insufficient_balance` and nothing is written.
A `REFUND` that claws back 5,000 from the same shop does not hit a guarded account. It is accepted, and the shop's running balance becomes -2,000.

## Known gaps
- Not confirmed in the code: what `isGuarded` takes as input, for example (journal kind, account, line direction). Only its location is known: `packages/backend/libs/domains/payments/domain/account.ts#isGuarded`.
- The spec does not say why only these accounts are guarded. The likely reason is to stop the platform from paying out money a seller does not hold, or from emptying `PAYOUT_CLEARING` below what it holds. This is design intent (not stated in the spec).
- The spec does not say whether a `PAYOUT_REVERSAL` or `ADJUSTMENT` line on a seller account is ever guarded. The rule names only `PAYOUT` debits for seller accounts.

## Used by
<!-- used-by:start -->
- [ledger-account](ledger-account.md)
- [minor-units](minor-units.md)
- [no-negative-guard](no-negative-guard.md)
- [payout-clearing](payout-clearing.md)
- [payout-journal](payout-journal.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
