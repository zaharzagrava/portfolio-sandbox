---
id: already-submitted
title: already_submitted (409)
kind: term
status: draft
aliases: [already_submitted]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# already_submitted (409)
## Definition
`already_submitted` is the conflict error a seller gets when saving a [questionnaire step](onboarding-questionnaire.md) after the [onboarding application](onboarding-application-status.md) was submitted. It applies while the application is [`SUBMITTED`](onboarding-application-status.md) or [`VERIFIED`](onboarding-application-status.md). The refused save creates no [draft](onboarding-draft.md) and changes no answers. It keeps the seller from editing answers that a moderator may already be checking.

## Example
A shop's application is `SUBMITTED`. The seller saves the `tax` step again with a corrected answer. The answer is `409 already_submitted`, and the submitted answers stay unchanged.

## Known gaps
- The spec does not say which route returns this code. The questionnaire endpoints come from tested scenarios and are not confirmed as built routes.
- The spec does not say what submit itself answers in these states. Submit is idempotent and answers `200` on a repeat, so it does not use this code for a repeated submit.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
