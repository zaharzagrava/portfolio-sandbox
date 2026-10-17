---
id: document-issue
title: Document issue
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: bc301d0bb419
---
# Document issue
## Definition
A document issue is a problem that the [hard rules](hard-checks.md) find in a model's extraction result for one [KYC ↗](../sw-external-terms.md#kyc) document. Any issue blocks [auto-approval](auto-approval), whatever the [model confidence](model-confidence) is (S04.R-16). Some issues are [escalating](escalating-issue) and trigger the [strong model](strong-model.md). The others send the document straight to [`NEEDS_REVIEW`](document-status.md) for a [moderator](moderator.md).

## Example
A bank statement's text tells the model to ignore its instructions. The account holder also differs from the business name. One model call is made, and the holder mismatch keeps the document out of approval, so it goes to `NEEDS_REVIEW` (S04.B-10).

## Known gaps
- The spec does not list the full set of issue kinds or their names.
- The spec does not say whether pre-model findings such as `content_type_mismatch` (S04.B-11) count as issues or are a separate review reason.
- The spec does not say whether the issues are shown to the moderator on the review task.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-15
- [document-review](document-review.md)
<!-- used-by:end -->
