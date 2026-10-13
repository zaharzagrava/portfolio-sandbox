---
id: aggregate-rows
title: aggregateRows
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# aggregateRows
## Definition
`aggregateRows` is a [pure function ↗](../sw-external-terms.md#pure-function) in the payments domain layer, in `lock-order.ts`. The spec cites it as the code behind S14.R-04: money must be [integer minor units](minor-units.md) within the [safe-integer range ↗](../sw-external-terms.md#safe-integer-range). When a [running balance](running-balance.md) would fall outside that range, the [posting](ledger-posting.md) is refused with [`balance_overflow`](balance-overflow.md). It sits next to [`compareRows`](compare-rows.md), which sets the ascending (account, shard) order a posting locks its [balance rows](balance-row.md) in. The posting is [atomic ↗](../sw-external-terms.md#atomicity), so this refusal writes nothing.

## Example
An illustrative posting has two lines that hit the same seller account `SHOP_<uuid>`. If the resulting running balance would pass JavaScript's `Number.MAX_SAFE_INTEGER`, the posting fails with `balance_overflow`. No entries, balance change or outbox event are written.

## Known gaps
- Not confirmed in the code: whether `aggregateRows` merges a journal's lines into one delta per balance row (account, shard, currency). The name and the file it sits in suggest that, but the facts do not say so.
- The spec does not say whether the overflow check runs on each line's amount, on the combined delta per row, or only on the resulting balance.
- The spec does not say whether `balance_overflow` is retryable, or how it reaches an HTTP caller.

## Used by
<!-- used-by:start -->
- [balance-row](balance-row.md)
- [ledger-posting](ledger-posting.md)
- [minor-units](minor-units.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
