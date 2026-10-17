---
id: document-already-approved
title: document_already_approved (409)
kind: term
status: draft
aliases: [document_already_approved]
defined_for: S04-kyc-onboarding
rules_hash: 58687989c37b
---
# document_already_approved (409)
## Definition
`document_already_approved` is the [conflict error](conflict-error.md) a seller gets when requesting an [upload](document-upload.md) for a [document kind](document-kind.md) that is already approved. An approved kind needs no new file. The refusal means a new upload cannot [supersede](document-supersede.md) an approved document.

## Example
A shop's [`BANK_STATEMENT`](onboarding-document-type.md) is `APPROVED`, and its `BUSINESS_REGISTRATION` is still in [`NEEDS_REVIEW`](document-status.md). The seller requests another `BANK_STATEMENT` upload. The answer is `409 document_already_approved`.

## Known gaps
- The spec does not say whether an approval carries over to a new round after the application is rejected and submitted again. It does not say whether the kind can be uploaded again in that new round.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [document-kind](document-kind.md)
- [document-supersede](document-supersede.md)
- [document-upload](document-upload.md)
- [onboarding-document-type](onboarding-document-type.md)
<!-- used-by:end -->
