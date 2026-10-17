---
id: review-task
title: Review task
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: b7f2ee25b5ef
---
# Review task
## Definition
A review task is a [moderator](moderator.md)'s work item for one document that the automatic checks could not approve. It is created when a document goes to [`NEEDS_REVIEW`](document-status.md). Only [platform `ADMIN`](platform-admin.md) and `MODERATOR` users can list and resolve tasks, and not for shops they belong to. A task is resolved in one of three ways:
- **Approve.** The same [hard checks](hard-checks.md) as [extraction](extraction-message.md) apply. The moderator may correct values.
- **Reject the document.** A reason is required.
- **Reject the whole application.**

## Example
A task holds an invalid IBAN. A moderator approves it with a corrected IBAN. The task stores the masked extracted and corrected values, and the sealed row holds the correction.

A second moderator who resolves the same task gets [`409 task_already_resolved`](task-already-resolved.md).

## Known gaps
- The spec does not give the stored value for the open status. It is written only as "open", unlike `APPROVED`, `REJECTED` and `CANCELLED`.
- Not confirmed in the code: the moderator list and resolve endpoints come from scenarios, not confirmed routes.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-14, B-09
- [auto-approval](auto-approval.md)
- [conflict-of-interest](conflict-of-interest.md)
- [content-type-mismatch](content-type-mismatch.md)
- [document-review](document-review.md)
- [document-supersede](document-supersede.md)
- [document-superseded](document-superseded.md)
- [escalating-issue](escalating-issue.md)
- [holder-name-check](holder-name-check.md)
- [iban-invalid](iban-invalid.md)
- [masked-value](masked-value.md)
- [missing-object](missing-object.md)
- [moderation-task-status](moderation-task-status.md)
- [onboarding-status-history](onboarding-status-history.md)
- [real-file-type](real-file-type.md)
- [rejection-reason-code](rejection-reason-code.md)
- [shop-onboarding-document-rejected-event](shop-onboarding-document-rejected-event.md)
- [superseded-document](superseded-document.md)
- [task-already-resolved](task-already-resolved.md)
<!-- used-by:end -->
