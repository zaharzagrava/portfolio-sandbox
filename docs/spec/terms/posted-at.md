---
id: posted-at
title: postedAt
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# postedAt
## Definition
`postedAt` is the posting time stamped on every line of a [journal](ledger-journal.md). All lines of one journal carry the same `postedAt`, so a journal never spans two moments. The value comes from the [injected clock](injected-clock.md), not from each line's own write time. Journal headers and entries are [append-only ↗](../sw-external-terms.md#append-only), so a journal's `postedAt` never changes after the posting.

## Example
A [`SALE` journal](journal-kind.md) for one captured payment has three lines, all with the same timestamp (value illustrative):
```
[PROVIDER_CLEARING](ledger-system-accounts.md)     -10000  postedAt 2026-10-13T09:15:00Z
MARKETPLACE_CLEARING   +9950  postedAt 2026-10-13T09:15:00Z
PLATFORM_FEES            +50  postedAt 2026-10-13T09:15:00Z
```

## Known gaps
- The spec does not say whether `postedAt` decides which [closed UTC day](closed-utc-day.md) a journal belongs to during [reconciliation](reconciliation.md).
- The spec does not say how a [correcting journal](correction-path.md) stores "[the day it corrects](corrects-day.md)", or whether that is separate from its own `postedAt`.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [correction-path](correction-path.md)
- [corrects-day](corrects-day.md)
- [injected-clock](injected-clock.md)
- [journal-kind](journal-kind.md)
- [ledger-journal](ledger-journal.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->
