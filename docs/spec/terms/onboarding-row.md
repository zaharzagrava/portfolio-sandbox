---
id: onboarding-row
title: Onboarding row
kind: term
status: draft
aliases: [relational row]
defined_for: S04-kyc-onboarding
rules_hash: 150c1be22363
---
# Onboarding row
## Definition
The onboarding row is the relational database record of a shop's application. It is created only at [submission](onboarding-submit.md), never while the seller is still [saving steps](onboarding-step.md). [Submit is idempotent ↗](../sw-external-terms.md#idempotency), so repeated or racing submits do not create duplicate rows. The [application status](onboarding-application-status.md) (`SUBMITTED`, `VERIFIED`, `REJECTED`) and the [`submissionNo`](submission-no.md) belong to this application.

## Example
A seller saves all four steps. Nothing has been written to the onboarding table yet. On submit, the row appears with status `SUBMITTED` and `submissionNo: 1`. Submitting again leaves that same single row.

## Known gaps
- Not confirmed in the code: that this row lives in the `ShopOnboarding` table. That is the likely owner by name, but the facts do not link the two explicitly.
- The spec does not say whether a resubmission after `REJECTED` updates the same row or adds a new one.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-02
- [onboarding-draft-lifetime](onboarding-draft-lifetime.md)
- [post-consumption-submit](post-consumption-submit.md)
<!-- used-by:end -->
