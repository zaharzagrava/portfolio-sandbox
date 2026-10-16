---
id: resubmission-required
title: resubmission_required (409)
kind: term
status: draft
aliases: [resubmission_required]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# resubmission_required (409)
## Definition
`resubmission_required` is the [conflict error](conflict-error.md) a seller gets when requesting a [document upload](document-upload.md) while the application is rejected. The seller must save a [questionnaire step](onboarding-questionnaire.md) and submit again. Submitting again starts a new round with a higher [`submissionNo`](submission-no.md), and uploads are accepted again. A rejected single document does not trigger this code: a newer file of that kind [supersedes](document-supersede.md) it.

## Example
A moderator rejects a shop's application, `shop.rejected` is published, and the application is `REJECTED`. The seller requests a `BANK_STATEMENT` upload and gets `409 resubmission_required`. The seller saves a step and submits again, which gives `submissionNo: 2`. The upload request then succeeds.

## Known gaps
- The spec does not say "application" explicitly; it says "when rejected". This page reads it as a rejected application, because a rejected document can be replaced by a new upload.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
