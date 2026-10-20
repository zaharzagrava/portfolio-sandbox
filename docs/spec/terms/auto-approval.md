---
id: auto-approval
title: Auto-approval
kind: term
status: draft
aliases: [auto-approve]
defined_for: S04-kyc-onboarding
rules_hash: e6720ce54766
---
# Auto-approval
## Definition
Auto-approval means the [extraction worker](extraction-worker.md) moves a document to [`APPROVED`](document-status.md) without a human reviewer. It happens only when the model answer passes every [hard rule](hard-checks.md) and has no [document issue](document-issue) (S04.R-16). [Model confidence](model-confidence) alone never causes it. Every doubtful case goes to a [moderator](moderator.md) through a [review task](review-task.md) instead.

## Example
A queued `BUSINESS_REGISTRATION` is processed. The cheap model's answer passes every rule, so exactly one call is made and the document becomes `APPROVED` (S04.B-07).

## Known gaps
- The spec does not say directly that an auto-approved document counts toward the "last required kind approved" step that makes the application `VERIFIED` (S04.R-26). It most likely does.
- The spec does not say whether moderators can see or reverse an auto-approval.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-04
- [S04](../capabilities/S04-kyc-onboarding.md): R-16
- [document-validation-rule](document-validation-rule.md)
- [extraction-worker](extraction-worker.md)
- [hard-checks](hard-checks.md)
- [holder-name-check](holder-name-check.md)
- [moderator](moderator.md)
- [review-task](review-task.md)
<!-- used-by:end -->
