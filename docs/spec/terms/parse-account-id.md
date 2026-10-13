---
id: parse-account-id
title: parseAccountId
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# parseAccountId
## Definition
`parseAccountId` is the payments domain function that checks an account id on a [journal line](ledger-posting.md) and recognises it as a known [ledger account](ledger-account.md). It accepts only the fixed [system accounts](ledger-system-accounts.md) and [shop accounts](shop-account.md) of the form `SHOP_<uuid>`. Any other id is refused with [`account_unknown`](account-unknown.md), and so is an id with a [shard suffix](ledger-balance-shard.md). Shards stay internal to the ledger. Callers always name the [logical account](logical-account.md), and the ledger picks the shard itself from the [shard key](shard-key.md). Keeping shards out of caller input is design intent (not stated in the spec).

## Example
A payouts module calls [`postJournal`](post-journal.md) with these line accounts:
```
"PAYOUT_CLEARING"        -> accepted (system account)
"SHOP_3f2a…"             -> accepted (shop account; uuid illustrative)
"BUYER_42"               -> refused: account_unknown (the buyer is never a ledger account)
"PLATFORM_FEES" + shard  -> refused: account_unknown (suffix format illustrative)
```

## Known gaps
- The spec does not say whether `parseAccountId` accepts the short name `CLEARING` as input, or whether that name is only used for display.
- Not confirmed in the code: what `parseAccountId` returns, or whether it checks that the part after `SHOP_` is a well-formed UUID.
- The spec does not say whether a shop account is refused when its shop does not exist, or only when its id is malformed.

## Used by
<!-- used-by:start -->
- [ledger-account](ledger-account.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [ledger-posting](ledger-posting.md)
- [ledger-system-accounts](ledger-system-accounts.md)
- [logical-account](logical-account.md)
- [shard-key](shard-key.md)
- [shop-account](shop-account.md)
<!-- used-by:end -->
