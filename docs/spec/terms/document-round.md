---
id: document-round
title: Document round
kind: term
status: draft
aliases: [round]
defined_for: S04-kyc-onboarding
rules_hash: f3c80e8fdf1f
---
# Document round
## Definition
A document round is the set of documents uploaded for one submission of a shop's onboarding application. Uniqueness, deduplication and the [per-kind document cap](document-limit-reached.md) all count within a single round. When a rejected application is submitted again, a new round starts with a higher [`submissionNo`](submission-no.md). [The purge job](onboarding-document-purge-job.md) deletes a round's [raw files](raw-document-file.md) a set time after that round is verified or rejected.

## Example
A shop's first round is rejected. The seller saves a step and submits again, and the answer shows `submissionNo: 2`. Documents uploaded from now on belong to the new round and have their own per-kind cap.

## Known gaps
- The spec does not say whether the round number is the same value as `submissionNo`, or how the round is stored.
- The spec does not say what happens to approved documents from an earlier round when a new round starts.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
