---
id: ledger-reconciliation-completed-event
title: ledger.reconciliation_completed event
kind: term
status: draft
aliases: [ledger.reconciliation_completed]
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# ledger.reconciliation_completed event
## Definition
`ledger.reconciliation_completed` is the event a [reconciliation run](reconciliation-run.md) emits when it finishes. It goes out through [the outbox](outbox-append.md), so it is published only if the run's transaction commits. Other parts of the platform can react to a finished daily check without [polling ↗](../sw-external-terms.md#polling) the [reconciliation API](finance-reconciliation-api.md). Each run is unique per (provider, day), so the event refers to one provider's statement for one [closed UTC day](closed-utc-day.md).

## Example
The [`payments.reconcile-daily`](payments-reconcile-daily-job.md) job reconciles the previous UTC day, for example 2026-10-12 (illustrative). The run reaches [`COMPLETED`](reconciliation-run-status.md), and `ledger.reconciliation_completed` is appended to the outbox.

## Known gaps
- The spec does not say what the event payload contains, for example the run id, the day or the issue counts.
- The spec does not say which topic carries this event, or whether a `FAILED` run also emits it.
- The spec does not say which consumers subscribe to it.

## Used by
<!-- used-by:start -->
- [closed-utc-day](closed-utc-day.md)
- [finance-reconciliation-api](finance-reconciliation-api.md)
- [outbox-append](outbox-append.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->
