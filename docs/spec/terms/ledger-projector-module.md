---
id: ledger-projector-module
title: LedgerProjectorModule
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# LedgerProjectorModule
## Definition
`LedgerProjectorModule` is one of the three ledger modules exported from the ledger's public entry point, next to [`LedgerModule`](ledger-module.md) and [`LedgerWorkerModule`](ledger-worker-module.md). Its name suggests it hosts the balance [read-model](read-model.md) side of the ledger, which is the [`BalanceProjector`](balance-projector.md). That projector consumes [`ledger.journal_posted`](ledger-journal-posted-event.md) from the [`ledger.events`](ledger-events-topic.md) topic in [consumer group `ledger-balances`](consumer-group.md). An application includes this module when it should run that projection, and leaves it out when it should not.

## Example
A process that serves [`GET /shops/:shopId/balance`](get-shop-balance.md) from the read model also needs the projector running somewhere. That process, or a separate one, imports `LedgerProjectorModule` so that `BalanceProjector` keeps applying `ledger.journal_posted` v2 events to the read model.

## Known gaps
- Not confirmed in the code: which providers `LedgerProjectorModule` registers. The link to `BalanceProjector` comes from the module's name, not from a verified import list.
- The spec does not say which deployable (API, worker or a dedicated process) is meant to import it, or whether it can run alongside `LedgerWorkerModule`.

## Used by
<!-- used-by:start -->
- [consumer-group](consumer-group.md)
- [read-model](read-model.md)
<!-- used-by:end -->
