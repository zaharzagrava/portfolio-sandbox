---
id: kyc-record-retention-days
title: kycRecordRetentionDays
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# kycRecordRetentionDays
## Definition
`kycRecordRetentionDays` is the retention period for [KYC records ↗](../sw-external-terms.md#kyc) in the onboarding capability. A scheduled job erases a shop's KYC records once this period has passed. It is separate from the [onboarding document purge job](onboarding-document-purge-job.md), which deletes only [raw document files](raw-document-file.md) and keeps the [sealed and masked fields](sealed-row.md). Consuming [`tenancy.shop_deleted`](shop-deleted-event.md) also schedules this erasure, while deleting raw files at once.

## Example
A shop's application becomes [`VERIFIED`](onboarding-application-status.md). Thirty days later the purge job deletes the raw files, but the sealed copy and masked values remain (S04.B-19). Later, once `kycRecordRetentionDays` has passed, the erase job removes those remaining KYC records.

## Known gaps
- The spec does not say the value of `kycRecordRetentionDays`, where it is configured, or from which moment the period is counted.
- The spec does not say which records are erased (for example, whether `DocumentExtraction` sealed rows, `ReviewTask` rows and `OnboardingStatusHistory` are all included).
- The spec does not say whether the erasure scheduled on `tenancy.shop_deleted` uses this same period or runs sooner.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
