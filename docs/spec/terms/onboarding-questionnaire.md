---
id: onboarding-questionnaire
title: Onboarding questionnaire
kind: term
status: draft
aliases: [questionnaire step, step]
defined_for: S04-kyc-onboarding
rules_hash: 689033858d94
---
# Onboarding questionnaire
## Definition
The onboarding questionnaire is the set of business answers a seller gives before a shop can be [verified](shop-verification.md). It is split into fixed, named [steps](onboarding-step.md): `business`, `tax`, `catalog` and `policies`. Each step is saved on its own, and the [onboarding view](onboarding-application-status.md) shows which steps are still missing. [The request body is strict](strict-body.md): an unknown step name, an unknown field or a non-object body is refused. The caller needs the [`shop.manage` permission](permission.md) on the shop.

## Example
A [shop member](shop-member.md) saves the `business` step. The onboarding view then shows [status `DRAFT`](onboarding-application-status.md), the saved answers, and missing steps `tax`, `catalog`, `policies`. Only after all steps are saved can the seller [submit](onboarding-submit.md) (see onboarding-submit).

## Known gaps
- The spec does not say which fields each step contains. Only `vatRegistered`, `vatNumber` and a business country are mentioned.
- Not confirmed in the code: the questionnaire endpoints come from tested scenarios, not from a confirmed list of built routes.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-01
- [already-submitted](already-submitted.md)
- [document-not-required](document-not-required.md)
- [onboarding-application-status](onboarding-application-status.md)
- [onboarding-document-type](onboarding-document-type.md)
- [onboarding-step](onboarding-step.md)
- [onboarding-submit](onboarding-submit.md)
- [permission](permission.md)
- [required-onboarding-documents](required-onboarding-documents.md)
- [resubmission-required](resubmission-required.md)
- [shop-member](shop-member.md)
- [shop-verification](shop-verification.md)
- [strict-body](strict-body.md)
- [submission-required](submission-required.md)
- [submission](submission.md)
- [vat-number](vat-number.md)
<!-- used-by:end -->
