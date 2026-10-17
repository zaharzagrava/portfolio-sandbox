---
id: moderator
title: Moderator
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: a2a241364949
---
# Moderator
## Definition
A moderator is a platform staff member with the [`MODERATOR` platform role](platform-role.md) who works through KYC review tasks. Only `MODERATOR` and `ADMIN` may call the review endpoints. Any other caller gets [`403 insufficient_role`](insufficient-role.md). A reviewer who is a member of the shop under review gets `403 conflict_of_interest`. Design intent (not stated in the spec): this stops people from verifying their own shop.

## Example
A moderator rejects a `BANK_STATEMENT` with a reason of 3 to 500 characters. The document becomes `REJECTED`, the seller sees the reason, and [`shop.onboarding_document_rejected`](shop-onboarding-document-rejected-event.md) is appended.

## Known gaps
- The spec does not say whether `ADMIN` and `MODERATOR` have different powers on the review endpoints.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-13, B-14
- [auto-approval](auto-approval.md)
- [document-issue](document-issue.md)
- [document-status](document-status.md)
- [document-supersede](document-supersede.md)
- [document-superseded](document-superseded.md)
- [document-validation-rule](document-validation-rule.md)
- [hard-checks](hard-checks.md)
- [holder-name-check](holder-name-check.md)
- [iban-invalid](iban-invalid.md)
- [masked-value](masked-value.md)
- [missing-object](missing-object.md)
- [moderation-task-status](moderation-task-status.md)
- [moderation-task](moderation-task.md)
- [onboarding-application-status](onboarding-application-status.md)
- [platform-role](platform-role.md)
- [rejection-reason-code](rejection-reason-code.md)
- [review-task](review-task.md)
- [sealed-row](sealed-row.md)
- [shop-onboarding-document-rejected-event](shop-onboarding-document-rejected-event.md)
- [submission-no](submission-no.md)
- [task-already-resolved](task-already-resolved.md)
<!-- used-by:end -->
