---
id: model-call
title: Model call
kind: term
status: draft
aliases: [model calls]
defined_for: S04-kyc-onboarding
rules_hash: 4988450b811f
---
# Model call
## Definition
A model call is one request to an AI model that reads a [KYC ↗](../sw-external-terms.md#kyc) document and returns extracted values. The [extraction worker](extraction-worker.md) makes it after it takes the [`onboarding.extract_document` message](extraction-message.md). The cheap model is called first. The [strong model](strong-model.md) is called once more only when an issue is marked escalating. The answer must be strict JSON of the schema, and hard rules decide acceptance, not the model's confidence. No database transaction is open during the call.

## Example
A `BANK_STATEMENT` comes back from the cheap model with a low-confidence IBAN. That issue escalates, so a second call goes to the strong model. If its answer passes every rule, the document becomes `APPROVED`. If the call times out, the document stays `EXTRACTING` and the queue redelivers the message.

## Known gaps
- The spec does not name the cheap or strong model or the provider.
- The spec does not say which issues are marked escalating, apart from a low-confidence IBAN.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-29, B-11, B-12
- [content-type-mismatch](content-type-mismatch.md)
- [escalating-issue](escalating-issue.md)
- [extraction-attempt](extraction-attempt.md)
- [extraction-message](extraction-message.md)
- [extraction-worker](extraction-worker.md)
- [real-file-type](real-file-type.md)
- [strong-model](strong-model.md)
<!-- used-by:end -->
