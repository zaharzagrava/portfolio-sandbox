---
id: shop-rejected-event
title: shop.rejected event
kind: term
status: draft
aliases: [shop.rejected]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# shop.rejected event
## Definition
`shop.rejected` is an event that the [tenancy capability](tenancy-domain-layer.md) consumes. It carries the decision that a shop failed verification. It is one of the only three events that may change a shop's [verification status](shop-verification.md) and [`payoutsEnabled`](payouts-enabled.md), through the [lifecycle state machine ↗](../sw-external-terms.md#state-machine) in [`VerificationService`](verification-service.md). A [duplicate delivery ↗](../sw-external-terms.md#at-least-once-delivery) changes nothing. If it arrives before [`shop.onboarding_submitted`](shop-onboarding-submitted-event.md), the shop stays rejected and the late submission does not reopen it.

## Example
`shop.rejected` arrives for a shop, and the shop's verification becomes rejected. Then the delayed `shop.onboarding_submitted` arrives. The shop stays rejected.

## Known gaps
- The spec does not say which capability publishes this event, what its payload contains (for example a rejection reason), or the exact status value it sets.
- The spec does not say whether a rejected shop can submit again and be verified later.
- The spec does not say what happens if [`shop.verified`](shop-verified-event.md) arrives after `shop.rejected` for the same shop.

## Used by
<!-- used-by:start -->
- [shop-verification](shop-verification.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
