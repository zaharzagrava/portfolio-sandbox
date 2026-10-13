---
id: payout-clearing
title: PAYOUT_CLEARING
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# PAYOUT_CLEARING
## Definition
`PAYOUT_CLEARING` is one of the platform's fixed [system ledger accounts](ledger-system-accounts.md). It is a [guarded account](guarded-account.md) on every line of every journal: no posting may take its [running balance](running-balance.md) below zero. The [no-negative guard](no-negative-guard.md) runs in the same atomic step as the balance update, and a breach is refused with `insufficient_balance`. It is not one of the [sharded hot accounts](hot-account.md), so it has a single balance row per currency. The account is likely a holding place for seller money between leaving a shop account and being sent; this is design intent (not stated in the spec).

## Example
`PAYOUT_CLEARING` holds 2,000 minor units (illustrative). A journal with a line of -5,000 on `PAYOUT_CLEARING` would leave it at -3,000. It is refused with `insufficient_balance`, and no line, balance or outbox event is written.

## Known gaps
- The spec does not say which journal kinds put lines on `PAYOUT_CLEARING`. It also does not say how the account relates to `PAYOUTS_SENT`.
- The spec does not say when money leaves `PAYOUT_CLEARING`, for example on payout confirmation or on a `PAYOUT_REVERSAL`.

## Used by
<!-- used-by:start -->
- [guarded-account](guarded-account.md)
- [hot-account](hot-account.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [no-negative-guard](no-negative-guard.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
