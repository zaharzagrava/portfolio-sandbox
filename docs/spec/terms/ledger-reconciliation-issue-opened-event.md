---
id: ledger-reconciliation-issue-opened-event
title: ledger.reconciliation_issue_opened event
kind: term
status: draft
aliases: [ledger.reconciliation_issue_opened]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# ledger.reconciliation_issue_opened event
## Definition
`ledger.reconciliation_[issue](reconciliation-issue.md)_opened` is the event a [reconciliation run](reconciliation-run.md) emits for each new issue it creates. Examples of issues are a [`MISSING_IN_LEDGER`](reconciliation-issue-kind.md) or an [`AMOUNT_MISMATCH`](reconciliation-issue-kind.md) between [the provider's statement](provider-statement.md) and the ledger. The event goes out through the [outbox](inbox-table.md), so it is published only if the issue is committed. Issues are unique per (run, kind, reference), so a restarted run should not open the same issue twice. Whether it emits the event twice is not confirmed.

## Example
A statement line has provider reference `pi_123` (illustrative), but no `SALE` journal matches it. The run stores a `MISSING_IN_LEDGER` issue and appends one `ledger.reconciliation_issue_opened` event.

## Known gaps
- The spec does not say what the payload contains or which topic carries it.
- Not confirmed in the code: whether a crashed run that restarts its day can emit this event a second time for an issue that already exists.
- The spec does not say whether any event is emitted when an issue is resolved, either automatically or by an operator.

## Used by
<!-- used-by:start -->
- [inbox-table](inbox-table.md)
- [provider-statement](provider-statement.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->
