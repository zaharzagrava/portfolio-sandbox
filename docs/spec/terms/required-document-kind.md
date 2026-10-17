---
id: required-document-kind
title: Required document kind
kind: term
status: draft
aliases: [kind]
defined_for: S04-kyc-onboarding
rules_hash: 6ada6a2181dc
---
# Required document kind
## Definition
A [document kind](document-kind.md) the shop must have [approved](document-review.md) before the application can become [`VERIFIED`](onboarding-application-status.md). The set is fixed at [submit time](onboarding-submit.md) from the questionnaire answers. Some kinds are always required, and the VAT certificate is required only for [VAT-registered](vat-registered.md) shops (see S04.R-04). Requesting an upload for a kind that is not required is refused with [`document_not_required`](document-not-required.md). Approving the last outstanding required kind verifies the shop.

## Example
```json
{ "submitted": true, "submissionNo": 1,
  "requiredDocuments": ["BUSINESS_REGISTRATION", "BANK_STATEMENT"] }
```
The submit answer above is for a shop with `vatRegistered: false`. The list format is illustrative. A `VAT_CERTIFICATE` request for that shop answers `422 document_not_required`.

## Known gaps
- The spec does not say whether the required set is recomputed on a new submission after a rejection, for example if the VAT answer changes.
- The spec does not say the exact shape of `requiredDocuments` in the submit answer.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-26, B-17
- [document-not-required](document-not-required.md)
- [submission](submission.md)
- [verification-document-purge-job](verification-document-purge-job.md)
<!-- used-by:end -->
