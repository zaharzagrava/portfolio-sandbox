---
id: reconciliation-run-service
title: ReconciliationRunService
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# ReconciliationRunService
## Definition
`ReconciliationRunService` is the payments [application-layer](application-layer.md) service that carries out a [reconciliation run](reconciliation-run.md) for one provider and one [closed UTC day](closed-utc-day.md). It reads the [provider statement](provider-statement.md) as a [lazily advanced stream](lazy-statement-stream.md). It asks for the next page only after it has finished the current one, so it never holds more than one page. While it works, it sends job heartbeats so its [job lease](job-lease.md) stays alive through a long statement. Design intent (not stated in the spec): memory use stays flat no matter how many lines the day has.

## Example
A run for the provider's statement of 2026-10-12 (illustrative day). `ReconciliationRunService` processes page 1 and sends a heartbeat. Only then does it ask for page 2, and by that point it no longer holds page 1.

## Known gaps
- The spec does not say which job calls this service. It is probably `payments.reconcile-daily`, but that is not confirmed.
- Not confirmed in the code: whether this service also matches lines, writes issues and moves the run state, or leaves that to the domain functions (`classifyLine`, `nextRunState`). Only the streaming rule (S14.R-29) points to this service.
- The spec does not give the page size, or say whether the provider or this system chooses it.

## Used by
<!-- used-by:start -->
- [application-layer](application-layer.md)
- [closed-utc-day](closed-utc-day.md)
- [job-lease](job-lease.md)
- [lazy-statement-stream](lazy-statement-stream.md)
- [provider-statement](provider-statement.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->
