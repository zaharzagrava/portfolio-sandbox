---
id: extraction-evidence
title: Extraction evidence
kind: term
status: draft
aliases: [evidence]
defined_for: S04-kyc-onboarding
rules_hash: 0c2bdf9a9dfb
---
# Extraction evidence
## Definition
Extraction evidence is the supporting material a model answer attaches to an extracted value, such as where in the document the value was found. The [readable column](readable-column.md) stores extracted values without it. Keeping it out is design intent (not stated in the spec): evidence may quote raw document text, including personal data or injected instructions.

## Example
The model returns an [IBAN ↗](../sw-external-terms.md#iban) for a [`BANK_STATEMENT`](onboarding-document-type.md) together with evidence for it. Only the [masked IBAN](masked-value.md) goes into the readable column; the evidence is not stored there (S04.R-19).

## Known gaps
- The spec does not say what evidence contains or its shape in the [model's JSON schema](extraction-schema.md).
- The spec does not say whether the [sealed copy](sealed-copy.md) keeps the evidence or drops it too.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
