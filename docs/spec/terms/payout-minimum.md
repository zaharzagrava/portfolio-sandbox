---
id: payout-minimum
title: Payout minimum
kind: term
status: draft
aliases: [minimum balance]
defined_for: J01-buy-to-payout
rules_hash: d3f7872ce1cf
---
# Payout minimum
## Definition
The smallest [balance](authoritative-balance.md) a shop must have before the [weekly payout run](payouts-run-weekly-job.md) pays it. A shop below the minimum receives no [payout](payout-transfer.md) and keeps its balance. Instead, the run records [`blockedReason: "below_minimum"`](blocked-reason.md) for that shop. Avoiding transfers too small to be worth their cost is design intent (not stated in the spec).

## Example
A shop's balance is below the minimum when the [operator](operator.md) runs [`payouts.run-weekly`](payouts-run-weekly-job.md). No payout is created, the balance stays, and the shop shows:
```json
{ "blockedReason": "below_minimum" }
```

## Known gaps
- The spec does not say the value of the minimum, or whether it differs per shop or per currency.
- The spec does not say on which object or response `blockedReason` appears.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
