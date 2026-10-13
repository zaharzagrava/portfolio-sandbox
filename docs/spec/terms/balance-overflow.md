---
id: balance-overflow
title: balance_overflow
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# balance_overflow
## Definition
`balance_overflow` is the named reason a [posting](ledger-posting.md) is refused when a [running balance](running-balance.md) would end up outside the [safe-integer range ↗](../sw-external-terms.md#safe-integer-range). Money is held as integer [minor units](minor-units.md), and values past that range can no longer be represented exactly. The posting is [atomic ↗](../sw-external-terms.md#atomicity), so the refusal writes nothing: no entries, no balance change and no [outbox event](event-row.md). The check is in `[aggregateRows](aggregate-rows.md)` (`lock-order.ts`).

## Example
A posting that would push a seller account's running balance past the safe-integer limit (JavaScript's `Number.MAX_SAFE_INTEGER`) fails with `balance_overflow`. Its whole transaction rolls back.

## Known gaps
- The spec does not say whether `balance_overflow` is [retryable](retryable.md), or how it reaches an HTTP caller.
- The spec does not say whether the check runs on each line's amount, the combined delta per row, or only the resulting balance.

## Used by
<!-- used-by:start -->
- [event-row](event-row.md)
- [ledger-posting](ledger-posting.md)
- [minor-units](minor-units.md)
- [retryable](retryable.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
