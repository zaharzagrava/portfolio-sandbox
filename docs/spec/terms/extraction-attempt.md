---
id: extraction-attempt
title: Extraction attempt
kind: term
status: draft
aliases: [attempt, attempt row]
defined_for: S04-kyc-onboarding
rules_hash: 4f8f9285c30d
---
# Extraction attempt
## Definition
An extraction attempt is one recorded [model call](model-call) on one document by the [extraction worker](extraction-worker). A document gets at most two attempts: the [cheap model](cheap-model) first, then the [strong model](strong-model) once, and only when an issue is [escalating](escalating-issue) (S04.R-15). A completed attempt is never repeated, and a [lease](concurrency-lease) keeps duplicate workers away (S04.R-20). Provider errors (timeouts and some HTTP error statuses) write no attempt row. They propagate so the queue redelivers the message (S04.R-21). The [sealed copy](sealed-copy) of extracted values is bound to the document and to the attempt (S04.R-19).

## Example
`BANK_STATEMENT`, low-confidence IBAN (B-08):
- Attempt 1 uses the [cheap model](cheap-model.md) and flags an [escalating](escalating-issue.md) issue.
- Attempt 2 uses the [strong model](strong-model.md), and its answer passes the rules. The document becomes `APPROVED`.

If the strong-[model call](model-call.md) had timed out instead, no row is written. The document stays `EXTRACTING` until the message is redelivered (B-12).

## Known gaps
- Not confirmed in the code: that attempt rows live in the `DocumentExtraction` table, or what columns they have.
- The spec does not say whether an `invalid_output` attempt counts toward the two-call maximum.
- The spec does not say whether a [content type mismatch](content-type-mismatch) or a [missing object](missing-object) writes an attempt row. Both skip the model call (S04.R-18).

## Used by
<!-- used-by:start -->
- [cheap-model](cheap-model.md)
- [escalating-issue](escalating-issue.md)
- [invalid-output](invalid-output.md)
- [model-call](model-call.md)
- [readable-column](readable-column.md)
- [sealed-copy](sealed-copy.md)
- [sealed-row](sealed-row.md)
- [strong-model](strong-model.md)
<!-- used-by:end -->
