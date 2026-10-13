---
id: shop-onboarding-submitted-event
title: shop.onboarding_submitted event
kind: term
status: draft
aliases: [shop.onboarding_submitted]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# shop.onboarding_submitted event
## Definition
`shop.onboarding_submitted` is an event that the [tenancy capability](tenancy-domain-layer.md) consumes. It says that a shop has submitted its onboarding for verification. It is one of three events that are allowed to change a shop's [verification status](shop-verification.md), together with `shop.verified` and `shop.rejected`. [`VerificationService`](verification-service.md) handles it through the [lifecycle state machine ↗](../sw-external-terms.md#state-machine). [Receiving the same event twice changes nothing.](consumer-outcomes.md) If a decision already arrived, a late submission does not undo it.

## Example
A shop is created by `POST /shops` and starts with verification `UNVERIFIED` and [`payoutsEnabled`](payouts-enabled.md) false. The seller then submits onboarding, and `shop.onboarding_submitted` arrives for that shop. Tenancy moves the shop into its submitted verification state. If the same event is delivered again, nothing changes.

## Known gaps
- The spec does not say which capability publishes this event, or what its payload contains.
- The spec does not say which verification status value this event sets.
- The spec does not say whether this event changes `payoutsEnabled`.

## Used by
<!-- used-by:start -->
- [consumer-outcomes](consumer-outcomes.md)
- [shop-verification](shop-verification.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
