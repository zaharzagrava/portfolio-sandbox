---
id: parse-statement-line
title: parseStatementLine
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# parseStatementLine
## Definition
`parseStatementLine` is the [domain-layer](domain-layer.md) function that validates one line of the [provider statement](provider-statement.md) before [reconciliation](reconciliation.md) uses it. It sits in the reconciliation matcher next to [`classifyLine`](classify-line.md), which matches valid lines to [`SALE`](journal-kind.md) and `REFUND` journals by [provider reference](journal-kind-reference.md). No statement line takes part in matching until it has passed this function. Validating at the domain boundary means bad provider data is caught as data and does not crash the run; this is design intent (not stated in the spec).

## Example
A statement line with no currency (shape illustrative) fails validation, so it is not matched against any journal:
```json
{ "reference": "pi_123", "amountMinor": 2500 }
```

## Known gaps
- The spec does not list the fields or checks that `parseStatementLine` applies.
- Not confirmed in the code: that a line which fails `parseStatementLine` always becomes an [`INVALID_PROVIDER_RECORD` issue](reconciliation-issue-kind.md).
- The spec does not say whether an invalid line is reported as a result value or as a thrown error.

## Used by
<!-- used-by:start -->
- [domain-layer](domain-layer.md)
- [journal-kind-reference](journal-kind-reference.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->
