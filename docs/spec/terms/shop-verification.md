---
id: shop-verification
title: Shop verification
kind: term
status: draft
aliases: [unverified, verification]
defined_for: S03-shops-rbac
rules_hash: c18a821fec65
---
# Shop verification
## Definition
Shop verification is a [lifecycle ↗](../sw-external-terms.md#state-machine) that records whether the [seller organisation](shop-tenant.md) has been checked. It is separate from [shop status](shop-status.md). Every new shop starts `UNVERIFIED` and can move to `PENDING`. From `PENDING` it moves to `VERIFIED` or `REJECTED`, and a `REJECTED` shop can return to `PENDING`. `VERIFIED` is final, and only a verified shop has [`payoutsEnabled`](payouts-enabled.md) true.

## Example
`UNVERIFIED → PENDING → REJECTED → PENDING → VERIFIED` is a valid path. `VERIFIED → PENDING` is not allowed. [`applyVerification`](apply-verification.md) in `verification-status.ts` applies these moves, and a change emits [`tenancy.shop_verification_changed`](shop-verification-changed-event.md).

## Known gaps
- The spec does not say who or what triggers each transition, for example a seller action, an admin or an external provider.
- The spec does not say which checks a shop must pass to become `VERIFIED`.
- The spec does not say which error an invalid verification move returns.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-28
- [S04](../capabilities/S04-kyc-onboarding.md): B-19
- [apply-verification](apply-verification.md)
- [onboarding-document-type](onboarding-document-type.md)
- [onboarding-questionnaire](onboarding-questionnaire.md)
- [payouts-enabled](payouts-enabled.md)
- [post-shops](post-shops.md)
- [required-onboarding-documents](required-onboarding-documents.md)
- [shop-onboarding-submitted-event](shop-onboarding-submitted-event.md)
- [shop-rejected-event](shop-rejected-event.md)
- [shop-status](shop-status.md)
- [shop-tenant](shop-tenant.md)
- [shop-verification-changed-event](shop-verification-changed-event.md)
- [shop-verified-event](shop-verified-event.md)
- [verification-decision-ordering](verification-decision-ordering.md)
<!-- used-by:end -->
