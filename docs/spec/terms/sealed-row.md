---
id: sealed-row
title: Sealed row
kind: term
status: draft
aliases: [sealed, sealed fields]
defined_for: S04-kyc-onboarding
rules_hash: 94bc8f7af9da
---
# Sealed row
## Definition
A sealed row is the protected copy of a document's extracted values. It is bound to one document and one [extraction attempt](extraction-attempt.md). The [readable column](readable-column.md) keeps only masked values without [evidence](extraction-evidence.md), while the sealed copy keeps the full values. When a [moderator](moderator.md) corrects a value during approval, the sealed row holds the correction. Sealed and masked fields survive the [purge of raw files](raw-document-file.md).

## Example
A task has an invalid IBAN. A moderator approves it with a corrected IBAN. The task stores the masked extracted IBAN and the masked corrected IBAN. The sealed row stores the corrected IBAN in full.

## Known gaps
- The spec does not say which table holds the sealed copy, though `DocumentExtraction` is a likely candidate.
- The spec does not say how sealing is done or who may read the sealed values.
- The spec does not give a value for `kycRecordRetentionDays`, the setting that controls when sealed rows are erased.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
