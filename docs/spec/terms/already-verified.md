---
id: already-verified
title: already_verified (409)
kind: term
status: draft
aliases: [already_verified]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# already_verified (409)
## Definition
`already_verified` is the [conflict error](conflict-error.md) a seller gets when requesting a [document upload](document-upload.md) after the application is [`VERIFIED`](onboarding-application-status.md). A verified shop has every [required document](required-onboarding-documents.md) approved, so no further documents are accepted. It is the document-side refusal. [Step saves](onboarding-step.md) in the same state answer [`already_submitted`](already-submitted.md) instead.

## Example
A shop became `VERIFIED` when its last required document was approved, and `shop.verified` was emitted. The seller then requests a `VAT_CERTIFICATE` upload. The answer is `409 already_verified`.

## Known gaps
- The spec does not say how a verified shop updates its documents later, for example after changing bank account. No path out of `VERIFIED` is described.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [document-upload](document-upload.md)
- [onboarding-step](onboarding-step.md)
- [required-onboarding-documents](required-onboarding-documents.md)
<!-- used-by:end -->
