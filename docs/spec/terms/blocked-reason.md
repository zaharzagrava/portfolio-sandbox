---
id: blocked-reason
title: blockedReason
kind: term
status: draft
aliases: [below_minimum]
defined_for: J01-buy-to-payout
rules_hash: e3b0c44298fc
---
# blockedReason
## Definition
`blockedReason` is a field that says why the [payout run](payouts-run-weekly-job.md) did not pay a shop. The facts name only one value: `"below_minimum"`. The run sets it when the shop's [balance](authoritative-balance.md) is under the [payout minimum](payout-minimum.md). In that case, no [payout](payout-transfer.md) is created and the shop keeps its balance. The field lets the owner or operator see why no money arrived, which is design intent (not stated in the spec).

## Example
The operator runs `payouts.run-weekly`. One shop's balance is under the payout minimum, so the run creates no payout and leaves the balance in place. The shop is marked with the following (the surrounding shape is illustrative):
```json
{ "blockedReason": "below_minimum" }
```

## Known gaps
- The spec does not say which object or API response carries `blockedReason`. It could be the balance, a payout record or a run result.
- The spec does not say whether values other than `"below_minimum"` exist, for example a missing [payout destination](payout-destination.md).
- The spec does not say whether `blockedReason` is cleared once a later run pays the shop.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
