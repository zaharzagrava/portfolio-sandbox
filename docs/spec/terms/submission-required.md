---
id: submission-required
title: submission_required (409)
kind: term
status: draft
aliases: [submission_required]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# submission_required (409)
## Definition
`submission_required` is the [conflict error](conflict-error.md) a seller gets when requesting a [document upload](document-upload.md) before the [onboarding application](onboarding-application-status.md) is submitted. Documents belong to a [submitted round](document-round.md), so the [questionnaire](onboarding-questionnaire.md) must be submitted first. The refused request creates no document. Design intent (not stated in the spec): the required document kinds depend on the submitted answers, for example `vatRegistered`, so they are unknown before submit.

## Example
A shop is still in `DRAFT`. The seller asks for a `BUSINESS_REGISTRATION` [upload grant](upload-grant.md). The answer is `409 submission_required`. After the seller submits, the same request answers `201` with status `AWAITING_UPLOAD`.

## Known gaps
- The spec does not say whether this code also applies to the confirm-upload endpoint, or only to the upload-grant request.
- The spec does not say which code wins when a request breaks several rules at once, for example a rate limit and the missing submit.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
