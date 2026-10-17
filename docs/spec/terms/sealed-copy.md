---
id: sealed-copy
title: Sealed copy
kind: term
status: draft
aliases: [sealed]
defined_for: S04-kyc-onboarding
rules_hash: cc44ca05dda4
---
# Sealed copy
## Definition
The sealed copy is the encrypted form of the extracted values, stored next to the [masked readable column](readable-column.md). It is sealed with [SecretBox](secret-box.md) and bound to the document and the [extraction attempt](extraction-attempt.md), so it cannot be opened under another document or attempt. When a moderator corrects a value on approval, the [sealed row](sealed-row.md) holds the correction. It survives the [raw-file purge](raw-document-file.md).

## Example
A moderator approves a `BANK_STATEMENT` task with a corrected IBAN. The task keeps masked values, and the sealed row now holds the corrected IBAN (S04.B-14). Thirty days after verification, raw files are deleted but the sealed fields remain (S04.B-19).

## Known gaps
- The spec does not say who may unseal the copy or which flow reads it (for example, payout setup).
- The spec does not say whether the sealed copy is removed when KYC records are erased after [`kycRecordRetentionDays`](kyc-record-retention-days.md).

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-19
- [extraction-attempt](extraction-attempt.md)
- [extraction-evidence](extraction-evidence.md)
- [iban-invalid](iban-invalid.md)
- [masked-value](masked-value.md)
- [raw-document-file](raw-document-file.md)
- [readable-column](readable-column.md)
- [sealed-row](sealed-row.md)
- [secret-box](secret-box.md)
- [verification-document-purge-job](verification-document-purge-job.md)
<!-- used-by:end -->
