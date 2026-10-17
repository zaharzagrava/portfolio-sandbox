---
id: superseded-document
title: Superseded document
kind: term
status: draft
aliases: [superseded]
defined_for: S04-kyc-onboarding
rules_hash: 946a8a09269e
---
# Superseded document
## Definition
A document in status [`SUPERSEDED`](document-status.md). It is replaced when the seller confirms a newer file of the [same kind](document-kind.md) in the [same round](document-round.md). Only unresolved or rejected documents of that kind are superseded, and their [open review tasks](review-task.md) are cancelled. The seller's document list hides superseded documents. A moderator who tries to resolve a task for one gets [`document_superseded`](document-superseded.md).

## Example
A `BANK_STATEMENT` sits in [`NEEDS_REVIEW`](document-status.md) with an open review task. The seller uploads and confirms a new bank statement. The old document becomes `SUPERSEDED`, its task becomes `CANCELLED`, and only the new document appears in the seller's onboarding view.

## Known gaps
- The spec does not say when the raw file of a superseded document is deleted, or whether the round purge covers it.
- The spec does not say whether superseded documents count toward the per-kind document limit of a round.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-25
<!-- used-by:end -->
