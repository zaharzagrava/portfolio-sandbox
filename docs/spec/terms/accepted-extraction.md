---
id: accepted-extraction
title: Accepted extraction
kind: term
status: draft
aliases: [accepted]
defined_for: S04-kyc-onboarding
rules_hash: c237bbc6119f
---
# Accepted extraction
## Definition
An accepted extraction is the set of values taken from a [model answer](provider-raw-answer-kind.md) that matched the [extraction schema](extraction-schema). Only such answers are stored. An [`invalid_output`](invalid-output) answer stores nothing as accepted (S04.R-17). Accepted values are stored twice (S04.R-19):
- as [masked values](masked-value) in a [readable column](readable-column.md), without [evidence](extraction-evidence);
- in a [sealed copy](sealed-copy) [bound to the document and the](seal-context.md) [attempt](extraction-attempt).

Being accepted does not mean being approved: [rules decide](document-validation-rule), and any [issue](document-issue) blocks [auto-approval](auto-approval) (S04.R-16).

## Example
The cheap model returns valid JSON for a `BANK_STATEMENT`. The [IBAN ↗](../sw-external-terms.md#iban) is stored masked in the readable column and in full in the [sealed row](sealed-row.md) for that document and attempt. If the holder name differs from the business name, the document still goes to `[NEEDS_REVIEW](document-status.md)` (B-10).

## Known gaps
- The spec does not say whether an accepted extraction from the first model call is kept or replaced when the [strong model](strong-model) is called.
- Not confirmed in the code: which table holds the readable and sealed columns. `DocumentExtraction` is likely, but this is not verified.

## Used by
<!-- used-by:start -->
- [extraction-schema](extraction-schema.md)
- [invalid-output](invalid-output.md)
- [provider-raw-answer-kind](provider-raw-answer-kind.md)
- [readable-column](readable-column.md)
- [seal-context](seal-context.md)
- [sealed-row](sealed-row.md)
<!-- used-by:end -->
