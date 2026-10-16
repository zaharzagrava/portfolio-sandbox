---
id: document-not-required
title: document_not_required (422)
kind: term
status: draft
aliases: [document_not_required]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# document_not_required (422)
## Definition
`document_not_required` is the error a seller gets when requesting an upload of a [document kind](document-kind.md) that this shop does not need. [Required kinds](required-document-kind.md) come from the submitted [questionnaire](onboarding-questionnaire.md). A request for any other kind is refused, so no [document row](document-upload.md) is created.

## Example
A shop answered [`vatRegistered: false`](vat-registered.md). The seller then requests a `VAT_CERTIFICATE` upload:
```
HTTP 422
code: document_not_required
```

## Known gaps
- The spec does not say whether this check runs before or after the `409` refusals (for example [`submission_required`](submission-required.md)) when both apply.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
