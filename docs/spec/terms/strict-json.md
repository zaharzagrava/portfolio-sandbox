---
id: strict-json
title: Strict JSON model answer
kind: term
status: draft
aliases: [strict json]
defined_for: S04-kyc-onboarding
rules_hash: 9d1cdaf10eb6
---
# Strict JSON model answer
## Definition
A strict JSON model answer is model output that is valid JSON and matches the [extraction schema](extraction-message.md) exactly. Only such an answer is used as an [extraction result](extraction-evidence.md). Any other answer counts as [`invalid_output`](invalid-output), and nothing from it is stored as [accepted](extraction-evidence.md) (S04.R-17). Design intent (not stated in the spec): strict parsing stops loose or injected model text from reaching stored data.

## Example
```json
{ "iban": "DE00 0000 0000 0000 0000 00", "holderName": "Example GmbH" }
```
These field names and values are illustrative. The real schema is not in the facts. An answer such as `Sure! Here is the data: {...}` is not strict JSON, so it is [`invalid_output`](invalid-output.md).

## Known gaps
- The spec does not give the schema's fields or where the schema is defined.
- The spec does not say whether extra or missing fields count as a schema mismatch.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-17
<!-- used-by:end -->
