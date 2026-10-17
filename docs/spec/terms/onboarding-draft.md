---
id: onboarding-draft
title: Onboarding draft
kind: term
status: draft
aliases: [draft]
defined_for: S04-kyc-onboarding
rules_hash: fe7f02d7eefb
---
# Onboarding draft
## Definition
The onboarding draft holds a shop's saved step answers before the seller submits. While it exists, the application status is `DRAFT`. Each step save resets the draft lifetime. No relational row exists for the application until submission. Submit checks that the draft is complete and valid, and refuses it with [`400 validation_failed`](validation-failed-error.md) otherwise.

## Example
A seller saves the `business` step, and the view shows status `DRAFT` with `tax`, `catalog` and `policies` still missing. Each later save restarts the draft lifetime (7 days at the time of writing).

## Known gaps
- The spec does not say where the draft is stored, since it is not a relational row.
- The spec does not say what happens when the draft lifetime runs out. Presumably the application returns to `NOT_STARTED`, but this is not confirmed.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-02, B-03
- [already-submitted](already-submitted.md)
- [onboarding-draft-lifetime](onboarding-draft-lifetime.md)
- [onboarding-step](onboarding-step.md)
- [onboarding-submit](onboarding-submit.md)
- [post-consumption-submit](post-consumption-submit.md)
- [required-documents](required-documents.md)
- [vat-number](vat-number.md)
<!-- used-by:end -->
