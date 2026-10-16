---
id: ledger-period
title: Ledger period
kind: term
status: draft
aliases: [current period, period]
defined_for: S14-ledger-reconciliation
rules_hash: b3bbb123d83c
---
# Ledger period
## Definition
A ledger period is the accounting time span that a [journal](ledger-journal.md) belongs to. Once a [closed UTC day](closed-utc-day.md) has been reconciled, the [entries](ledger-posting.md) of that day never change. If something from that day turns out to be wrong, the fix is a new journal posted in the current period. That new journal also records which day it corrects. Earlier periods stay exactly as they were reconciled, and the correction can still be traced back to the day it fixes.

## Example
Suppose reconciliation finds that a `SALE` posted on 2026-10-10 was wrong (date illustrative). On 2026-10-13 an operator posts an [`ADJUSTMENT` journal](adjustment-journal.md). It is dated in the current period and records that it corrects 2026-10-10. The 2026-10-10 entries stay untouched.

## Known gaps
- The spec does not say how long a period is (a UTC day, a month or something else), or whether periods are formally opened and closed.
- The spec does not say which field on the journal records the corrected day, or what it is called.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-17, B-15
- [S14](../capabilities/S14-ledger-reconciliation.md): R-36
- [adjusted-resolution](adjusted-resolution.md)
- [adjustment-journal](adjustment-journal.md)
- [closed-utc-day](closed-utc-day.md)
- [corrects-day](corrects-day.md)
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [ledger-journal](ledger-journal.md)
- [ledger-posting](ledger-posting.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [reconciliation-resolution](reconciliation-resolution.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->
