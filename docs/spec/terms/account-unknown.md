---
id: account-unknown
title: account_unknown
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# account_unknown
## Definition
`account_unknown` is the named reason the ledger gives when a [journal line](ledger-posting.md) names an account outside its [closed list](closed-error-code.md). The valid accounts are `PROVIDER_CLEARING`, `MARKETPLACE_CLEARING`, `PLATFORM_FEES`, `PAYOUT_CLEARING`, `PAYOUTS_SENT` and `SHOP_<uuid>`. An account id that carries a [shard suffix](ledger-balance-shard.md) is also refused. Callers always name the [logical account](logical-account.md), and the ledger picks the shard itself. Design intent (not stated in the spec): shards are an internal detail, so no caller can target one or depend on one.

## Example
A [`postJournal`](post-journal.md) call with an [`ADJUSTMENT`](adjustment-journal.md) line on `BUYER_42` (illustrative) is refused with `account_unknown`. A line on a shard-suffixed `PLATFORM_FEES` id is refused the same way, and in both cases nothing is written.

## Known gaps
- The spec does not say the exact format of a shard suffix.
- The spec does not say whether the short name `CLEARING` is accepted as input or is only a display name.

## Used by
<!-- used-by:start -->
- [closed-error-code](closed-error-code.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-posting](ledger-posting.md)
- [logical-account](logical-account.md)
<!-- used-by:end -->
