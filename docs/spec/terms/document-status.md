---
id: document-status
title: Document status
kind: term
status: draft
aliases: [queued]
defined_for: S04-kyc-onboarding
rules_hash: eba2e7e39fa8
---
# Document status
## Definition
Document status is the lifecycle state of one uploaded [KYC ↗](../sw-external-terms.md#kyc) document. It starts at `AWAITING_UPLOAD` when the seller asks for an [upload grant](upload-grant.md). Confirming the upload sets `QUEUED`, and the [extraction worker](worker-instance.md) moves it to `EXTRACTING` when it [claims](write-behind-claim.md) it. The worker or a [moderator](moderator.md) then sets the outcome: [`NEEDS_REVIEW`](document-review.md), `APPROVED` or `REJECTED`. A newer file of the same kind sets older ones to [`SUPERSEDED`](document-supersede.md), which the seller never sees.

## Example
A seller requests a `BANK_STATEMENT` upload and gets `201` with status `AWAITING_UPLOAD`. Then:
- The seller confirms the upload: `QUEUED`.
- The worker claims it: `EXTRACTING`.
- The [cheap model](cheap-model.md)'s answer [passes every rule](document-validation-rule.md): `APPROVED`.

If the model call times out, the document stays `EXTRACTING` until the queue redelivers the message.

## Known gaps
- The spec does not say whether a document that is wrongly typed or missing its object passes through `EXTRACTING` before it reaches `NEEDS_REVIEW`.
- The spec does not say what happens to document statuses when a moderator rejects the whole application.
- Not confirmed in the code: no model file exists, so the statuses come only from the scenarios.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
