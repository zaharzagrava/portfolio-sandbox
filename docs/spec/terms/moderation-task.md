---
id: moderation-task
title: Moderation task
kind: term
status: draft
aliases: [open tasks, task, tasks]
defined_for: S04-kyc-onboarding
rules_hash: c2932976bf7d
---
# Moderation task
## Definition
A moderation task is a review task opened when a [KYC ↗](../sw-external-terms.md#kyc) document needs a human decision, for example because it is in [`NEEDS_REVIEW`](document-status.md). It is open until a [moderator](moderator.md) approves the document, rejects the document, or rejects the whole application. It can also become [`CANCELLED`](moderation-task-status.md) in three cases: a newer file [supersedes](document-supersede.md) the document, the application is rejected, or the shop is deleted. Resolving a task is a [conditional transition](optimistic-concurrency.md), so only one resolver wins.

## Example
There are 120 open tasks (illustrative). A moderator lists them with `limit=50` and pages in [`createdAt, id` ↗](../sw-external-terms.md#keyset-pagination) order until [`nextCursor: null`](pagination-cursor.md). A second moderator resolving the same task gets [`409 task_already_resolved`](task-already-resolved.md). If the document was replaced, they get [`409 document_superseded`](document-superseded.md).

## Known gaps
- The spec does not say whether an open task has an explicit status name. It is written only as "open".
- The spec does not say whether tasks have an owner or assignment between moderators.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-13, B-16, B-20
- [document-supersede](document-supersede.md)
- [document-validation-rule](document-validation-rule.md)
- [moderator](moderator.md)
- [optimistic-concurrency](optimistic-concurrency.md)
- [vat-invalid](vat-invalid.md)
<!-- used-by:end -->
