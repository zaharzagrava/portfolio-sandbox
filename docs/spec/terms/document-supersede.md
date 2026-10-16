---
id: document-supersede
title: Document supersede
kind: term
status: draft
aliases: [supersede, supersedes]
defined_for: S04-kyc-onboarding
rules_hash: 16ef6e3eed8a
---
# Document supersede
## Definition
Superseding is how a new file replaces an older one of the same document kind. It happens when the seller confirms a new upload of that kind. Older documents of that kind that are unresolved or [`REJECTED`](document-status.md) become `SUPERSEDED`, and their open [review tasks](review-task.md) are cancelled. Superseded documents are hidden from the seller. A [moderator](moderator.md) who later resolves a task for one gets [`409 document_superseded`](document-superseded.md).

## Example
1. A seller's `BUSINESS_REGISTRATION` sits in `NEEDS_REVIEW` with an open review task.
2. The seller uploads and confirms a clearer scan of the same document.
3. The old document becomes `SUPERSEDED`, its task becomes `CANCELLED`, and only the new document appears in the seller's view.

## Known gaps
- The spec does not list exactly which statuses count as "unresolved" (for example, whether a document in `EXTRACTING` is superseded).
- The spec does not say whether superseding is limited to the current [submission round](document-round.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
