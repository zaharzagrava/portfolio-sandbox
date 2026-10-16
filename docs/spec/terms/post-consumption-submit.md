---
id: post-consumption-submit
title: Post-consumption submit
kind: term
status: draft
aliases: [post-consumption]
defined_for: S04-kyc-onboarding
rules_hash: 33a14631db76
---
# Post-consumption submit
## Definition
A post-consumption [submit](onboarding-submit.md) is a submit request that arrives after an earlier submit has already been processed. Like a repeated or racing submit, it answers `200` with the same body as the original submit. It creates no duplicate [onboarding row](onboarding-row.md) and no duplicate [`shop.onboarding_submitted` event](shop-onboarding-submitted-event.md). This way, a client retry after a lost response is safe.

## Example
A seller's submit succeeds, but the network drops the response, so the client retries. The retry returns the same `{submitted: true, submissionNo: 1, ...}` body. There is still a single onboarding row and a single event.

## Known gaps
- The spec does not say what "consumption" refers to. One reading is that the first submit consumed the [draft](onboarding-draft.md); another is that the submitted event was consumed downstream. The reading in this page is an interpretation.
- The spec does not say whether this request counts against the [per-shop submission rate limit](rate-limit.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
