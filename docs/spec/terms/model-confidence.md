---
id: model-confidence
title: Model confidence
kind: term
status: draft
aliases: [confidence]
defined_for: S04-kyc-onboarding
rules_hash: ddb3d9744aa8
---
# Model confidence
## Definition
Model confidence is the model's own estimate of how sure it is about an [extracted value](extraction-message.md). In this system, confidence never decides whether a document is accepted. The [hard rules](hard-checks.md) decide that (S04.R-16). Low confidence can still matter as an input, for example when it leads to the [strong model](strong-model.md) being called. Design intent (not stated in the spec): a model can be confidently wrong, or be manipulated by the document text, so its self-assessment is not trusted.

## Example
The [cheap model](cheap-model.md) returns an [IBAN ↗](../sw-external-terms.md#iban) with low confidence. That does not approve or reject the document by itself. It only triggers the strong-model call, and the rules then judge the strong model's answer (S04.B-08).

## Known gaps
- The spec does not say whether confidence is given per field or per document, or on what scale.
- The spec does not say whether high confidence can ever override a rule. S04.R-16 implies it cannot.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-16, B-08
- [cheap-model](cheap-model.md)
- [extraction-message](extraction-message.md)
- [hard-checks](hard-checks.md)
- [strong-model](strong-model.md)
<!-- used-by:end -->
