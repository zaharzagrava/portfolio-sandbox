---
id: masked-value
title: Masked value
kind: term
status: draft
aliases: [masked]
defined_for: S04-kyc-onboarding
rules_hash: de15aa6a4090
---
# Masked value
## Definition
A masked value is an extracted field stored with most of its content hidden, in a column that the system may read freely. It lets the [review task](review-task.md) and status views show what was extracted without exposing the full value. The full value lives only in the [sealed copy](sealed-copy.md). Masked values remain after the [purge job](onboarding-document-purge-job.md) deletes [raw files](raw-document-file.md).

## Example
After a [moderator](moderator.md) approves a task with a corrected IBAN, the task stores the masked extracted IBAN and the masked corrected IBAN; the full correction goes into the [sealed row](sealed-row.md) (S04.B-14).
```text
iban: "DE** **** **** **** **12 34"   (illustrative format)
```

## Known gaps
- The spec does not say the masking format (how many characters stay visible) or which fields are masked.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-19, B-14
- [extraction-evidence](extraction-evidence.md)
<!-- used-by:end -->
