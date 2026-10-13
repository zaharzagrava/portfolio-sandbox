---
id: order-tolerant
title: Order-tolerant
kind: term
status: draft
aliases: [order tolerant]
defined_for: S14-ledger-reconciliation
rules_hash: 757ef075791b
---
# Order-tolerant
## Definition
The [balance read model](read-model.md) is order-tolerant: it reaches the same result whatever order the [`ledger.journal_posted` events](ledger-journal-posted-event.md) arrive in. Each event line carries the line's resulting balance and [balance version](balance-version.md). The [projector](balance-projector.md) applies a line only when its version is newer than the stored one, so a late, older line changes nothing. Why the projector needs this is design intent (not stated in the spec): with [at-least-once delivery ↗](../sw-external-terms.md#at-least-once-delivery), events can arrive late, more than once, or out of order.

## Example
The projector ([consumer group](consumer-group.md) `ledger-balances`) stores version 7 for the balance row of `SHOP_<uuid>` shard 0. After that, a line with version 6 arrives late. The projector skips it, and the stored balance stays the version 7 value. (The version numbers are illustrative.)

## Known gaps
- The spec does not say whether a skipped older line is counted or logged (for example as a stale consumer outcome) or just dropped silently.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-25
- [balance-projector](balance-projector.md)
- [balance-version](balance-version.md)
- [consumer-group](consumer-group.md)
- [ledger-journal-posted-event](ledger-journal-posted-event.md)
- [read-model](read-model.md)
- [rebuildable-read-model](rebuildable-read-model.md)
<!-- used-by:end -->
