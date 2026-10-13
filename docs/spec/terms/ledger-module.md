---
id: ledger-module
title: LedgerModule
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# LedgerModule
## Definition
`LedgerModule` is a [NestJS module ↗](../sw-external-terms.md#nestjs-module) exported from the ledger's [public entry point](entry-point.md). Other domains, such as payments, payouts and ad billing, import it to use the ledger [in-process](in-process-port.md). The public entry point exports no models, so code outside the ledger reaches ledger data only through what is exported. Those exports are [`LedgerService`](ledger-service.md), [`LEDGER_ACCOUNTS`](ledger-accounts.md), [`shopAccount`](shop-account.md), [`LedgerJournalKind`](journal-kind.md) and [`JournalPosted`](journal-posted-event.md). Its siblings [`LedgerWorkerModule`](ledger-worker-module.md) and [`LedgerProjectorModule`](ledger-projector-module.md) hold the background parts of the ledger.

## Example
An ad billing module (illustrative) imports `LedgerModule` and injects `LedgerService`. Inside its own transaction, it calls [`postJournal`](post-journal.md) with kind `AD_CHARGE`, using `shopAccount(...)` for the seller line.

## Known gaps
- Not confirmed in the code: that `LedgerModule` is the module that provides `LedgerService`. This is inferred from the names and the export list.
- The spec does not say which controllers, if any, `LedgerModule` registers, such as the balance controller or the reconciliation controller.

## Used by
<!-- used-by:start -->
- [entry-point](entry-point.md)
- [in-process-port](in-process-port.md)
<!-- used-by:end -->
