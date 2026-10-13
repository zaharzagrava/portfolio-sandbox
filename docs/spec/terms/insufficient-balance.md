---
id: insufficient-balance
title: insufficient_balance
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# insufficient_balance
## Definition
`insufficient_balance` is the named reason the ledger gives when it refuses a posting because a guarded balance would go below zero. Two cases are guarded: a [`PAYOUT` journal](journal-kind.md) that debits a seller account, and any line on [`PAYOUT_CLEARING`](ledger-system-accounts.md). The check happens [atomically ↗](../sw-external-terms.md#atomicity) with the [running balance](running-balance.md) update, so two concurrent payouts cannot both pass it. Other journal kinds, such as a [`REFUND` clawback](clawback.md), may still take a seller account negative.

## Example
Shop account `SHOP_<uuid>` holds 1,000 minor units (illustrative). A `PAYOUT` journal debits it by 1,500. The posting is refused with `insufficient_balance` and the balance stays at 1,000.

## Known gaps
- The spec does not say how `insufficient_balance` reaches the caller: an error class, a result value, or an HTTP status.
- The spec does not say whether the refusal forces the caller's [shared transaction](active-transaction.md) to roll back, or only leaves the ledger writes out.

## Used by
<!-- used-by:start -->
- [active-transaction](active-transaction.md)
- [clawback](clawback.md)
- [journal-kind](journal-kind.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
