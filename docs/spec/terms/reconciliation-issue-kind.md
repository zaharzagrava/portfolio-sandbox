---
id: reconciliation-issue-kind
title: Reconciliation issue kinds
kind: term
status: draft
aliases: [amount_mismatch, currency_mismatch, duplicate_at_provider, invalid_provider_record, missing_at_provider]
defined_for: S14-ledger-reconciliation
rules_hash: 7683ea88d602
---
# Reconciliation issue kinds
## Definition
An issue kind names what type of difference [reconciliation](reconciliation.md) found between a [statement line](provider-statement.md) and the [`SALE`/`REFUND` journals](journal-kind.md). `MISSING_IN_LEDGER`: the provider has a reference that no journal has. `MISSING_AT_PROVIDER`: a journal has no matching statement line. `AMOUNT_MISMATCH` and `CURRENCY_MISMATCH`: both sides exist but disagree. `DUPLICATE_AT_PROVIDER`: the provider lists a reference more than once. `INVALID_PROVIDER_RECORD`: a statement line failed validation.

## Example
A refund journal shows 2500 but the statement line shows 2000 (illustrative values), so [`classifyLine`](classify-line.md) produces an `AMOUNT_MISMATCH` issue for that reference.

## Known gaps
- The spec defines the kinds only by their names. The meanings above are read from those names.
- On each run, open `MISSING_*` issues from recent days are checked again and [auto-resolved](reconciliation-issue-auto-resolve.md) if they now match. The spec does not say whether other kinds can ever be auto-resolved.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-35
- [classify-line](classify-line.md)
- [journal-kind](journal-kind.md)
- [parse-statement-line](parse-statement-line.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue-auto-resolve](reconciliation-issue-auto-resolve.md)
- [reconciliation-issue-status](reconciliation-issue-status.md)
- [reconciliation](reconciliation.md)
<!-- used-by:end -->
