---
id: verification-document-purge-job
title: Verification document purge job
kind: term
status: draft
aliases: [purge job]
defined_for: S04-kyc-onboarding
rules_hash: 5902e212fa3b
---
# Verification document purge job
## Definition
A scheduled job that deletes the raw uploaded document files of a [round](document-round.md) some time after the round is verified or rejected. [Sealed and masked extracted values](sealed-copy.md) are kept. When the last [required kind](required-document-kind.md) is approved, exactly one purge job is created in [the same transaction ↗](../sw-external-terms.md#database-transaction) that makes the application [`VERIFIED`](onboarding-application-status.md). The [retention delay](bounded-retention.md) is set by the rules, not here.

## Example
A shop's application became `VERIFIED` 30 days ago. When the purge job runs, the raw files in storage are deleted. The masked readable values and the sealed copy remain in [`DocumentExtraction`](extraction-evidence.md).

## Known gaps
- The spec does not say the job type name, or how the job is scheduled when a round is rejected instead of verified.
- The spec does not say what happens if the storage delete fails partway, for example whether the job retries or how much is deleted.
- Not confirmed in the code: no handler path is given for this job. Shop deletion through [`tenancy.shop_deleted`](shop-deleted-event.md) deletes raw files immediately, separately from this job.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-26
- [bounded-retention](bounded-retention.md)
- [document-round](document-round.md)
- [late-result](late-result.md)
- [required-document-kind](required-document-kind.md)
- [sealed-copy](sealed-copy.md)
<!-- used-by:end -->
