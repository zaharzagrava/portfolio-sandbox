---
id: shop-verified-event
title: shop.verified event
kind: term
status: draft
aliases: [shop.verified]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# shop.verified event
## Definition
`shop.verified` is an event that [the tenancy capability](tenancy-domain-layer.md) consumes. It carries the decision that a shop passed verification. It is one of the only three events that may change a shop's [verification status](shop-verification.md) and [`payoutsEnabled`](payouts-enabled.md), through the [lifecycle state machine ↗](../sw-external-terms.md#state-machine) in [`VerificationService`](verification-service.md). A duplicate delivery changes nothing. If it arrives before `shop.onboarding_submitted`, the shop stays decided and the late submission does not move it back.

## Example
`shop.verified` arrives for a shop before its delayed `shop.onboarding_submitted`. The shop becomes verified. When the submission event arrives later, the shop stays verified.

## Known gaps
- The spec does not say which capability publishes this event, or what its payload contains.
- The spec does not say whether this event turns `payoutsEnabled` on. Turning payouts on would be the natural effect, but that is a guess, not a stated rule.
- The spec does not say what happens if `shop.rejected` arrives after `shop.verified` for the same shop.

## Used by
<!-- used-by:start -->
- [shop-verification](shop-verification.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
