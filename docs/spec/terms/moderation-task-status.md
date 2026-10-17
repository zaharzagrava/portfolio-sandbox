---
id: moderation-task-status
title: Moderation task status
kind: term
status: draft
aliases: [cancelled, open]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# Moderation task status
## Definition
The state of a [review task](review-task.md), which is the human-review item created for a doubtful [KYC ↗](../sw-external-terms.md#kyc) document. A task starts open, and a [moderator](moderator.md) closes it as `APPROVED` or `REJECTED`. The system sets it to `CANCELLED` in three cases: a newer file [supersedes](document-supersede.md) the document, the application is rejected, or the shop is deleted. Resolving a task is a [conditional transition](guarded-update.md), so only one resolver can win.

## Example
Two moderators approve the same open task at once. One wins and the task becomes `APPROVED`. The other gets `[409 task_already_resolved](task-already-resolved.md)`. Separately, when `[tenancy.shop_deleted](shop-deleted-event.md)` is consumed, all of that shop's open tasks become `CANCELLED`.

## Known gaps
- The spec does not give the exact stored value of the open status; it is written only as "open".
- The spec does not say which status the resolving task itself gets when a moderator uses it to reject the whole application.

## Used by
<!-- used-by:start -->
- [document-supersede](document-supersede.md)
- [guarded-update](guarded-update.md)
- [moderator](moderator.md)
- [review-task](review-task.md)
<!-- used-by:end -->
