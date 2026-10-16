---
id: onboarding-document-type
title: Onboarding document type
kind: term
status: draft
aliases: [document type, vat_certificate]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# Onboarding document type
## Definition
The onboarding document type is the kind of business document a seller uploads during [shop verification](shop-verification.md). The kinds are `BUSINESS_REGISTRATION`, `BANK_STATEMENT` and `VAT_CERTIFICATE`. Which kinds a shop must provide depends on its [questionnaire answers](onboarding-questionnaire.md): `VAT_CERTIFICATE` is required only when the shop is [VAT registered](vat-registered.md). Several rules apply per kind: the [per-round document limit](document-limit-reached.md), [deduplication](document-deduplicated-flag.md), [superseding older files](document-supersede.md), and the ["already approved" refusal](document-already-approved.md). The application becomes [`VERIFIED`](onboarding-application-status.md) once every required kind has an approved document.

## Example
After submitting, a shop that is not VAT registered gets these [required documents](required-onboarding-documents.md): `BUSINESS_REGISTRATION` and `BANK_STATEMENT`. When the seller requests a `BANK_STATEMENT` upload, the answer is `201` with status [`AWAITING_UPLOAD`](document-status.md).

## Known gaps
- The spec does not say what happens when a seller requests a kind name outside the three listed.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
