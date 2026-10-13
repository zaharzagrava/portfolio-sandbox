---
id: ledger-worker-module
title: LedgerWorkerModule
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# LedgerWorkerModule
## Definition
`LedgerWorkerModule` is a NestJS module exported from the ledger's public entry point. It is meant for [worker processes](worker-instance.md), not for request-serving ones. Based on its name, it most likely hosts the ledger's background work. That would be the settlement consumer on [`orders.events`](orders-events-topic.md) (group [`ledger-settlement`](consumer-group.md)) and the ledger jobs. Those jobs include [`payments.reconcile-daily`](payments-reconcile-daily-job.md), `ledger.sweep-hot-accounts` and [`ledger.ensure-partitions`](ledger-ensure-partitions.md). The balance read-model projector has its own module, `LedgerProjectorModule`.

## Example
A worker application (illustrative) imports `LedgerWorkerModule`. That worker then consumes `order.paid` to post `SETTLEMENT` journals, and runs the hourly hot-account sweep.

## Known gaps
- Not confirmed in the code: which consumers and job handlers `LedgerWorkerModule` actually registers. The contents described here are inferred from its name.
- The spec does not say whether `LedgerWorkerModule` imports `LedgerModule`, or whether a worker must import both.

## Used by
<!-- used-by:start -->
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
