---
id: onboarding-step
title: Onboarding step
kind: term
status: draft
aliases: [step, steps]
defined_for: S04-kyc-onboarding
rules_hash: d1f756c4d0f2
---
# Onboarding step
## Definition
An onboarding step is one named part of the seller questionnaire. The steps are `business`, `tax`, `catalog` and `policies`. A shop member with [`shop.manage`](permission.md) saves each step separately into the [onboarding draft](onboarding-draft.md). Saving one step never changes the others. A request with an unknown step name, an unknown field or a non-object body is refused. Step saves answer `409 already_submitted` while the application is `SUBMITTED` or `VERIFIED`.

## Example
A seller saves the `business` step. The onboarding view then shows `DRAFT`, the saved answers, and the missing steps `tax`, `catalog` and `policies`. Two simultaneous saves of `tax` and `catalog` both end up in the draft.

## Known gaps
- The spec does not list the fields of each step. It does not say which step holds `vatRegistered` and `vatNumber`.
- The spec does not give the route or HTTP method for saving a step.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
