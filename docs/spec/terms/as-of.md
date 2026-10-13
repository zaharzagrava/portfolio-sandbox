---
id: as-of
title: asOf
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: efe1578ae15d
---
# asOf
## Definition
`asOf` is the value that tells a reader how fresh a [read-model](read-model.md) balance is. It is one of the two ways the system makes staleness visible; the other is the [ledger lag metric](ledger-lag-metric.md). A reader compares `asOf` with the current time to see how old a balance might be.

## Example
An illustrative balance answer. Only [`availableMinor`](available-minor.md) and `asOf` are named in the facts, and the values are invented:
```json
{ "availableMinor": 12500, "asOf": "2026-10-12T09:30:00Z" }
```

## Known gaps
- The spec does not say what time `asOf` records (the journal's [`postedAt`](posted-at.md), the moment [the projector](balance-projector.md) applied it, or the moment of the read) or what format it uses.
- The spec does not say what `asOf` holds when the read falls back to the [running balance](running-balance.md).
- Not confirmed in the code: that `asOf` is a member of the `GET /shops/:shopId/balance` response.

## Used by
<!-- used-by:start -->
- [balance-projector](balance-projector.md)
- [balance-schema](balance-schema.md)
- [ledger-lag-metric](ledger-lag-metric.md)
- [read-model](read-model.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
