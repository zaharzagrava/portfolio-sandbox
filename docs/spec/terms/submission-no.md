---
id: submission-no
title: submissionNo
kind: term
status: draft
aliases: [submission number]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# submissionNo
## Definition
`submissionNo` is the number of a shop's [onboarding submission](onboarding-submit.md), returned in the submit answer. The first submission gets `1`. After a [moderator](moderator.md) rejects the application, the seller can save steps and submit again, and the number goes up. Submit is [idempotent ↗](../sw-external-terms.md#idempotency): a repeated or racing submit returns the same body, with the same `submissionNo`.

## Example
```json
{ "submitted": true, "submissionNo": 1, "requiredDocuments": [...] }
```
After a [`REJECTED`](onboarding-application-status.md) application is fixed and submitted again, the answer carries `"submissionNo": 2`.

## Known gaps
- The spec does not say whether `submissionNo` is the same thing as the "[round](document-round.md)" used for document uniqueness, document limits and raw-file purge.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
