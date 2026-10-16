---
id: submission
title: Submission
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: b303b7330f93
---
# Submission
## Definition
A submission is the seller's act of sending the completed [onboarding questionnaire](onboarding-questionnaire.md) for review. It validates every step and the VAT answers. It then moves the application to [`SUBMITTED`](onboarding-application-status.md), fixes the [required document kinds](required-document-kind.md), and emits [`shop.onboarding_submitted`](shop-onboarding-submitted-event.md). Submit is [idempotent ↗](../sw-external-terms.md#idempotency), so a repeated or racing submit returns the same answer. Submissions are rate-limited per shop. Document uploads are refused until a submission exists.

## Example
```json
{ "submitted": true, "submissionNo": 1,
  "requiredDocuments": ["BUSINESS_REGISTRATION", "BANK_STATEMENT"] }
```
The `requiredDocuments` value is illustrative for a shop that is not VAT registered. After a rejection, the next submission answers `submissionNo: 2`.

## Known gaps
- The spec does not say whether an idempotent repeat of a submit counts against the per-shop submission limit.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
