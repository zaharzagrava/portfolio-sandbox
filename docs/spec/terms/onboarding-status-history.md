---
id: onboarding-status-history
title: OnboardingStatusHistory
kind: term
status: draft
aliases: [onboarding status history]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# OnboardingStatusHistory
## Definition
`OnboardingStatusHistory` is one of the tables owned by the [KYC onboarding capability](onboarding-submit.md). Only this capability reads and writes it, under its [table ownership](table-ownership.md). The name suggests it keeps a record of status changes of an onboarding application, but the facts do not describe its contents. Design intent (not stated in the spec): it gives an [audit trail](audit-log.md) of how an application moved between [`DRAFT`](onboarding-application-status.md), `SUBMITTED`, `VERIFIED` and `REJECTED`.

## Example
A seller submits a complete draft, so the application moves from `DRAFT` to `SUBMITTED`. Later, the last required document is approved and the application becomes `VERIFIED`. A history row for each move would look like this (illustrative, columns not confirmed):
```json
{"shopId": "shop_123", "from": "SUBMITTED", "to": "VERIFIED", "at": "2026-10-16T09:00:00Z"}
```

## Known gaps
- The spec does not say which columns the table has, or which transitions write a row. This includes whether document or [review-task](review-task.md) status changes are recorded here, or only application status changes.
- The spec does not say whether rows are kept, purged or erased by the raw-file purge, by the erasure after `kycRecordRetentionDays`, or on `tenancy.shop_deleted`.
- Not confirmed in the code: the table appears only in the ownership list (`packages/backend/db/ownership.ts#OWNERSHIP`). No write path to it is cited.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
