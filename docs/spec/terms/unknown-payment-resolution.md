---
id: unknown-payment-resolution
title: Unknown payment resolution
kind: term
status: draft
aliases: [resolution]
defined_for: S13-payment-intents
rules_hash: ddba7136595e
---
# Unknown payment resolution
## Definition
Unknown payment resolution is the periodic sweep that settles payments stuck in [`UNKNOWN`](unknown-payment-outcome.md). A single worker runs it under a [job scheduler lease](job-lease.md). For each due payment, it runs a [provider lookup by our reference](provider-lookup.md) and applies what the provider reports (`COMPLETED`, `FAILED` or `PENDING`) through the same [guarded update](guarded-update.md) [the processor](payment-processor.md) uses. It never sends a new charge. If the provider is unreachable, the payment stays `UNKNOWN`. If the provider has no record, the payment stays `UNKNOWN` until the [provider lookup window](provider-lookup-window.md) has passed.

## Example
A charge timed out, so the payment is `UNKNOWN(provider_timeout)`. On the next sweep, the lookup by the order ID finds a succeeded provider intent. The payment becomes `COMPLETED` with a history row, a [ledger posting](ledger-posting.md) and a [`payments.payment_succeeded` event](payment-succeeded-event.md).

## Known gaps
- The spec does not say what happens to a payment whose lookup still finds no record after the window ends (for example, whether it becomes `FAILED` or stays `UNKNOWN` for manual handling).
- The spec does not define when an `UNKNOWN` payment is "due" (for example, a backoff schedule or a fixed delay after the attempt).
- Not confirmed in the code: no code reference is given for the sweep job. Only the schedule and the scheduler lease concept are stated.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-17, B-12
- [crash-recovery](crash-recovery.md)
- [decide-payment-status](decide-payment-status.md)
- [find-mismatch](find-mismatch.md)
- [guarded-update](guarded-update.md)
- [job-lease](job-lease.md)
- [ledger-posting](ledger-posting.md)
- [payment-processor](payment-processor.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [provider-lookup-window](provider-lookup-window.md)
- [provider-lookup](provider-lookup.md)
<!-- used-by:end -->
