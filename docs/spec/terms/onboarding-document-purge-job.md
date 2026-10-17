---
id: onboarding-document-purge-job
title: Onboarding document purge job
kind: term
status: draft
aliases: [purge job]
defined_for: S04-kyc-onboarding
rules_hash: 93f0fe52eda7
---
# Onboarding document purge job
## Definition
A scheduled job that deletes the [raw document files](raw-document-file.md) of an onboarding round after a waiting period. It applies after the round is verified or rejected. [Sealed and masked extracted values](sealed-row.md) are kept. When the last required document is approved, the purge job is scheduled in the [same transaction ↗](../sw-external-terms.md#database-transaction) that sets `VERIFIED`. Exactly one purge job is created for that transition.

## Example
A shop's application became `VERIFIED` 30 days ago. When the purge job runs, the uploaded bank statement PDF and the registration scan are deleted. The masked and sealed extracted values, such as the IBAN, stay in [`DocumentExtraction`](extraction-evidence.md).

## Known gaps
- The spec does not give the job's registered name or job type.
- The spec does not say how a rejected round schedules its purge, or what happens if a file is already missing when the job runs.
- Not confirmed in the code: no handler path is listed for this job. It is a separate job from the erasure of KYC records after [`kycRecordRetentionDays`](kyc-record-retention-days.md).

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-19
- [document-round](document-round.md)
- [kyc-record-retention-days](kyc-record-retention-days.md)
- [masked-value](masked-value.md)
- [raw-document-file](raw-document-file.md)
- [sealed-row](sealed-row.md)
<!-- used-by:end -->
