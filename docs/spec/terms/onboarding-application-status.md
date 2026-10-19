---
id: onboarding-application-status
title: Onboarding application status
kind: term
status: draft
aliases: [application, submitted, verified]
defined_for: S04-kyc-onboarding
rules_hash: 11a455b9a135
---
# Onboarding application status
## Definition
The onboarding application status is where a shop stands in the [KYC ↗](../sw-external-terms.md#kyc) onboarding flow. Its values are `NOT_STARTED`, `DRAFT`, `SUBMITTED`, `VERIFIED` and `REJECTED`. Saving a [step](onboarding-step.md) creates a `DRAFT`, and submitting moves it to `SUBMITTED`. Approval of the last required [document kind](document-kind.md) moves it to `VERIFIED`, and a [moderator](moderator.md)'s rejection moves it to `REJECTED`. Other rules, such as which step saves and document requests are allowed, depend on this status.

## Example
A seller saves the `business` step, so the view shows `DRAFT`. They complete all the steps and submit, so the status becomes `SUBMITTED` with [`submissionNo: 1`](submission-no.md). A moderator then rejects the application, so it becomes `REJECTED`. The seller saves a step and submits again, so it is `SUBMITTED` with `submissionNo: 2`.

## Known gaps
- The spec does not say what happens to a `DRAFT` when its draft lifetime runs out. It does not say whether the status goes back to `NOT_STARTED`.
- Not confirmed in the code: no model file exists for this capability. The statuses come from the scenarios only.
- The spec does not say whether saving a step after `REJECTED` shows `DRAFT` before the next submit.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-08
- [already-submitted](already-submitted.md)
- [document-kind](document-kind.md)
- [document-upload](document-upload.md)
- [moderator](moderator.md)
- [onboarding-questionnaire](onboarding-questionnaire.md)
- [onboarding-row](onboarding-row.md)
- [onboarding-step](onboarding-step.md)
- [rejected-operation](rejected-operation.md)
- [rejection-reason-code](rejection-reason-code.md)
- [submission-required](submission-required.md)
- [upload-grant](upload-grant.md)
<!-- used-by:end -->
