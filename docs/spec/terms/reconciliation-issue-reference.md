---
id: reconciliation-issue-reference
title: Reconciliation issue reference
kind: term
status: draft
aliases: [reference]
defined_for: S14-ledger-reconciliation
rules_hash: f4cc982fe1ad
---
# Reconciliation issue reference
## Definition
The reference is the key that says which payment an issue is about. Together with the run and the issue kind, it makes each issue unique. Because of this, a crashed run that restarts its day records each difference only once. [Statement lines](provider-statement.md) are matched to [journals](ledger-journal.md) by [provider reference](provider-idempotency-reference.md), so the reference most likely carries that value.

## Example
A run crashes after recording `MISSING_IN_LEDGER` for reference `pi_123` (illustrative). When the day restarts, the same difference is found again. No second issue is created, because (run, `MISSING_IN_LEDGER`, `pi_123`) already exists.

## Known gaps
- The spec does not say whether the reference is always the provider reference. For example, it does not say what an `INVALID_PROVIDER_RECORD` line without a usable reference uses.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-32
- [classify-line](classify-line.md)
- [issue](issue.md)
- [ledger-journal](ledger-journal.md)
- [post-finance-reconciliation-issue-resolve](post-finance-reconciliation-issue-resolve.md)
- [provider-idempotency-reference](provider-idempotency-reference.md)
- [provider-statement](provider-statement.md)
- [reconciliation-issue](reconciliation-issue.md)
<!-- used-by:end -->
