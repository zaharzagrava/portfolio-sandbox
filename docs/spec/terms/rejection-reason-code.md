---
id: rejection-reason-code
title: Rejection reason code
kind: term
status: draft
aliases: [reason code]
defined_for: S04-kyc-onboarding
rules_hash: 7adcd24b39c9
---
# Rejection reason code
## Definition
A coded reason a [moderator](moderator.md) supplies when rejecting a whole [onboarding application](onboarding-application-status.md). Rejecting the application moves it to [`REJECTED`](onboarding-application-status.md), cancels its open [review tasks](review-task.md) and publishes [`shop.rejected`](shop-rejected-event.md). It is separate from the free-text reason given when rejecting a single document. Afterwards the seller can save steps and submit again, which starts [a new round](document-round.md).

## Example
A moderator resolves a review task on a `SUBMITTED` application with "reject application" and a reason code. The application becomes `REJECTED`, the other open tasks become `CANCELLED`, and `shop.rejected` is published. A later resubmit returns `submissionNo: 2`.

## Known gaps
- The spec does not say which reason codes exist or what the request field is called.
- The spec does not say whether the seller sees the reason code, or whether it is carried in the `shop.rejected` event.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
