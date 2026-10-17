---
id: extraction-schema
title: Extraction schema
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: 47c2dc2e8dc2
---
# Extraction schema
## Definition
The extraction schema is the fixed JSON shape that a model answer must follow when the [extraction worker](extraction-worker) reads a document. An answer that is not [strict JSON](strict-json) of this schema is recorded as [`invalid_output`](invalid-output), and nothing from it is stored as [accepted](accepted-extraction.md) (S04.R-17). Passing the schema only means the answer can be read. [Hard checks](hard-checks) and [document validation rules](document-validation-rule) still decide whether the document is approved (S04.R-16).

## Example
The [cheap model](cheap-model) reads a `BANK_STATEMENT` and returns plain text with a JSON fragment inside. The answer does not match the schema, so the attempt counts as `invalid_output`.

## Known gaps
- The spec does not say which fields the schema contains, for example how the IBAN, holder name, issues or confidence are represented.
- The spec does not say whether each [document kind](document-kind) has its own schema, or whether the cheap and strong models share one.

## Used by
<!-- used-by:start -->
- [extraction-evidence](extraction-evidence.md)
- [invalid-output](invalid-output.md)
<!-- used-by:end -->
