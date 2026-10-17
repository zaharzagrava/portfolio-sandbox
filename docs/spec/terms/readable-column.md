---
id: readable-column
title: Readable column
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: eecc8d5f7c37
---
# Readable column
## Definition
The readable column holds the values the model extracted from a document, stored as masked values and without extraction evidence. It sits beside the sealed copy, which keeps the values bound to the document and the [extraction attempt](extraction-attempt.md). Code can read this column directly, with no unsealing step. Design intent (not stated in the spec): masked values let screens and logs show enough to recognise a value without exposing it in full. Masked fields remain after the onboarding document purge job deletes the raw document files.

## Example
The cheap model extracts an IBAN from a `BANK_STATEMENT`. The readable column stores only a masked form such as `DE** **** **** **** **12 34` (illustrative). The full value goes into the sealed copy (S04.R-19). After the purge job runs, this masked value is still there (S04.B-19).

## Known gaps
- The spec does not say which table or column name holds the readable values. `DocumentExtraction` is a likely candidate, but this is not confirmed.
- The spec does not say the masking format, such as how many characters stay visible or whether it differs per key field.
- The spec does not say who reads this column. The seller's document view exposes only `{id, kind, status, rejectionReason}` (S04.R-28).

## Used by
<!-- used-by:start -->
- [accepted-extraction](accepted-extraction.md)
- [extraction-evidence](extraction-evidence.md)
- [sealed-copy](sealed-copy.md)
- [sealed-row](sealed-row.md)
<!-- used-by:end -->
