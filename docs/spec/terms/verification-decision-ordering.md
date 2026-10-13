---
id: verification-decision-ordering
title: Verification decision ordering
kind: term
status: draft
aliases: [decided]
defined_for: S03-shops-rbac
rules_hash: 30a85b19082c
---
# Verification decision ordering
## Definition
Verification decision ordering is the rule for verification events that arrive out of order. The events are [`shop.onboarding_submitted`](shop-onboarding-submitted-event.md), [`shop.verified`](shop-verified-event.md) and [`shop.rejected`](shop-rejected-event.md). If a decision (verified or rejected) arrives before the submission, the shop keeps the decision, and the late submission does not move it back to an earlier state. Receiving the same event twice changes nothing. [Verification status](shop-verification.md) and [`payoutsEnabled`](payouts-enabled.md) change only through these events and the [lifecycle state machine ↗](../sw-external-terms.md#state-machine).

## Example
`shop.verified` arrives first, so the shop becomes verified. Then the delayed `shop.onboarding_submitted` arrives. The shop stays verified, and `payoutsEnabled` is not reset.

## Known gaps
- The spec does not say which verification status values exist besides `UNVERIFIED`, or exactly which value each event sets.
- The spec does not say which events turn `payoutsEnabled` on or off.
- The spec does not say what happens when `shop.rejected` arrives after `shop.verified` (or the reverse) for the same shop.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-28
- [shop-verification](shop-verification.md)
<!-- used-by:end -->
