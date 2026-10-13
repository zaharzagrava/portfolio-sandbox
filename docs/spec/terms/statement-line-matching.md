---
id: statement-line-matching
title: Statement line matching
kind: term
status: draft
aliases: [every line matched, matched]
defined_for: S14-ledger-reconciliation
rules_hash: 84d0c90f62ab
---
# Statement line matching
## Definition
Statement line matching is the [reconciliation step](reconciliation.md) that pairs each [validated line](provider-statement.md) of the provider's statement with a [`SALE` or `REFUND` journal](journal-kind.md) by [provider reference](provider-idempotency-reference.md). A line that pairs cleanly creates no [issue](reconciliation-issue.md). Any difference becomes an issue of one of these kinds:
- `MISSING_IN_LEDGER`
- `MISSING_AT_PROVIDER`
- `AMOUNT_MISMATCH`
- `CURRENCY_MISMATCH`
- `DUPLICATE_AT_PROVIDER`
- `INVALID_PROVIDER_RECORD`

Matching only reports. It never posts or corrects journals.

## Example
A statement line has reference `pi_123` and amount 2,000 EUR (illustrative). The `SALE` journal with reference `pi_123` has the same amount and currency, so the line is matched. If the journal had 1,950, the run would record an `AMOUNT_MISMATCH` issue.

## Known gaps
- The spec does not say which ledger amount is compared with a statement line: the full sale amount or the amount net of the platform fee.
- The spec does not say how a refund line is told apart from its sale when both carry the same provider reference.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): B-11
- [classify-line](classify-line.md)
- [journal-kind](journal-kind.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run-uniqueness](reconciliation-run-uniqueness.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->
