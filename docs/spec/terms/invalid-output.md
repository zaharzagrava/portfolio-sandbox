---
id: invalid-output
title: invalid_output
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# invalid_output
## Definition
`invalid_output` is the result recorded when a model answer is not [strict JSON](strict-json) of the [extraction schema](extraction-schema.md) (S04.R-17). Nothing from that answer is stored as an [accepted extraction](accepted-extraction.md). Do not confuse it with provider errors such as a timeout or a `429`. Those are [re-thrown so the queue redelivers the message](provider-failure.md), and they write no [attempt row](extraction-attempt.md) (S04.R-21).

## Example
The [cheap model](cheap-model.md) returns free text around a JSON fragment for a `VAT_CERTIFICATE`. The attempt is recorded as `invalid_output`, and no extracted VAT number is stored as accepted.

## Known gaps
- The spec does not say what happens to the document next. It could escalate to the strong model, go to `NEEDS_REVIEW`, or be retried.
- The spec does not say whether `invalid_output` uses up one of the two allowed model calls (S04.R-15).
- Not confirmed in the code: where `invalid_output` is stored. It may be an attempt status on `DocumentExtraction` or an issue code.

## Used by
<!-- used-by:start -->
- [accepted-extraction](accepted-extraction.md)
- [cheap-model](cheap-model.md)
- [extraction-attempt](extraction-attempt.md)
- [extraction-schema](extraction-schema.md)
- [provider-failure](provider-failure.md)
<!-- used-by:end -->
