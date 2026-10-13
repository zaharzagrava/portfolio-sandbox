---
id: lazy-statement-stream
title: Lazily advanced stream
kind: term
status: draft
aliases: [lazily advanced]
defined_for: S14-ledger-reconciliation
rules_hash: 9c3ad3c56cff
---
# Lazily advanced stream
## Definition
The [reconciliation run](reconciliation-run.md) reads the [provider statement](provider-statement.md) page by page. It fetches the next page only after it has finished with the current one. No more than one page is held in memory at a time. The run sends [job heartbeats](job-heartbeat.md) while it works, so its [job lease](job-lease.md) stays alive during a long statement. Design intent (not stated in the spec): memory use stays flat however busy the day was.

## Example
[`ReconciliationRunService`](reconciliation-run-service.md) processes page 1 of a day's statement, sends a heartbeat, and only then asks the [adapter](stripe-statement-adapter.md) for page 2. Page 1 is no longer held at that point.

## Known gaps
- The spec does not give the page size, or say whether the provider or this system chooses it.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-29
- [job-heartbeat](job-heartbeat.md)
- [job-lease](job-lease.md)
- [payments-reconcile-daily-job](payments-reconcile-daily-job.md)
- [provider-statement](provider-statement.md)
- [reconciliation-run-service](reconciliation-run-service.md)
- [reconciliation-run](reconciliation-run.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
<!-- used-by:end -->
