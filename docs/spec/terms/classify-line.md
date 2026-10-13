---
id: classify-line
title: classifyLine
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# classifyLine
## Definition
`classifyLine` is the function in the [reconciliation matcher](statement-line-matching.md) that decides what one [provider statement line](provider-statement.md) means for the ledger. It lives in the [payments domain layer](payments-domain-layer.md). During a [reconciliation run](reconciliation-run.md), it compares a statement line with the [`SALE`](journal-kind.md) or [`REFUND`](journal-kind.md) journal that has the same [provider reference](reconciliation-issue-reference.md). When the two sides differ, the result is a reconciliation issue of one of the [reconciliation issue kinds](reconciliation-issue-kind.md). It only reports. It never posts a journal or corrects the ledger.

## Example
A statement line for a refund shows 2000 in its currency's [minor units](minor-units.md), but the matching `REFUND` journal shows 2500. Both values are illustrative. `classifyLine` returns an `AMOUNT_MISMATCH` for that provider reference, and the run records it as an [open issue](reconciliation-issue-status.md).

## Known gaps
- The spec does not say which issue kinds `classifyLine` produces itself. `MISSING_AT_PROVIDER` is about a journal that has no statement line, so a check that looks at one line at a time cannot find it. `INVALID_PROVIDER_RECORD` could also come from [`parseStatementLine`](parse-statement-line.md), the step that checks each line first.
- The spec does not say what `classifyLine` returns when a line matches its journal exactly. It could return a "matched" result or no result at all.
- Not confirmed in the code: how `classifyLine` finds `DUPLICATE_AT_PROVIDER`. That needs to know about earlier lines with the same reference, which a single line does not provide.

## Used by
<!-- used-by:start -->
- [minor-units](minor-units.md)
- [payments-domain-layer](payments-domain-layer.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-kind](reconciliation-issue-kind.md)
- [reconciliation-issue-reference](reconciliation-issue-reference.md)
- [reconciliation-issue-status](reconciliation-issue-status.md)
- [reconciliation-run](reconciliation-run.md)
- [statement-line-matching](statement-line-matching.md)
<!-- used-by:end -->
