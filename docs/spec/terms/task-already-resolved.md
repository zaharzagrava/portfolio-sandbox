---
id: task-already-resolved
title: task_already_resolved (409)
kind: term
status: draft
aliases: [task_already_resolved]
defined_for: S04-kyc-onboarding
rules_hash: 812ff0644a9d
---
# task_already_resolved (409)
## Definition
The [conflict error](conflict-error.md) a [moderator](moderator.md) gets when they try to resolve a [review task](review-task.md) that another resolver has already resolved. Resolving a task is a [conditional transition](durable-conditional-write.md): it only succeeds while the task is still open. When two moderators act on the same task, one wins and the other receives this error. The losing call changes nothing and [appends no event](outbox-append.md).

## Example
Two moderators open the same bank statement task. One approves it and the other rejects it a moment later. The first call succeeds. The second answers `409 task_already_resolved`, and the document keeps the first decision.

## Known gaps
- The spec does not say whether a task that was [`CANCELLED`](moderation-task-status.md) (by a newer file or by rejecting the application) answers this code or another one.
- The spec does not say whether the [problem body](problem-body.md) tells the loser which decision won.

## Used by
<!-- used-by:start -->
- [shop-onboarding-document-rejected-event](shop-onboarding-document-rejected-event.md)
<!-- used-by:end -->
