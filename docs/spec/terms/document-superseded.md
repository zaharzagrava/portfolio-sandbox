---
id: document-superseded
title: document_superseded (409)
kind: term
status: draft
aliases: [document_superseded]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# document_superseded (409)
## Definition
The [conflict error](conflict-error.md) a [moderator](moderator.md) gets when they [resolve](resolve-issue.md) a [review task](review-task.md) whose document has already been [replaced by a newer file](document-supersede.md) of the same kind. The resolution is refused and nothing changes. The moderator should work on the task for the newer document instead.

## Example
A moderator has the review task for an old [`BUSINESS_REGISTRATION`](document-kind.md) open in their screen. Meanwhile the seller confirms a new file, which supersedes the old one. The moderator then clicks approve and gets `409 document_superseded`.

## Known gaps
- The spec does not say which code wins when a task is both already resolved or cancelled and its document is superseded.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
