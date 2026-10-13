---
id: rebuildable-read-model
title: Rebuildable read model
kind: term
status: draft
aliases: [rebuildable]
defined_for: S14-ledger-reconciliation
rules_hash: 7546a4093b0d
---
# Rebuildable read model
## Definition
The balance [read model](read-model.md) is rebuildable: you can throw its contents away and build them again, and the [ledger](ledger.md) loses nothing. The [source of truth](source-of-truth.md) is the ledger's [journals](ledger-journal.md) and [running balances](running-balance.md), not the read model. A rebuild is safe because applying events is [idempotent ↗](../sw-external-terms.md#idempotency) and [order-tolerant](order-tolerant.md). Running the same events again gives the same stored balances.

## Example
After a [projector](balance-projector.md) bug is fixed, an operator clears the [durable copy](durable-copy.md) for the affected accounts. Balances are then filled again from [`ledger.journal_posted` v2 events](ledger-journal-posted-event.md) or from the running balances. While that happens, reads fall back to the running balance. (This scenario is illustrative.)

## Known gaps
- The spec does not say how a rebuild is started, or whether it replays events or copies the running balances.
- Not confirmed in the code: that the [`ledger.backfill-balances` job](ledger-backfill-balances-job.md) is the rebuild mechanism. The name suggests it, but no fact links the two.
- The spec does not say whether enough event history is kept to replay from the beginning.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-25
- [balance-projector](balance-projector.md)
- [durable-copy](durable-copy.md)
- [ledger-backfill-balances-job](ledger-backfill-balances-job.md)
- [ledger-journal-posted-event](ledger-journal-posted-event.md)
- [ledger-journal](ledger-journal.md)
- [ledger](ledger.md)
- [order-tolerant](order-tolerant.md)
- [read-model](read-model.md)
- [running-balance](running-balance.md)
- [source-of-truth](source-of-truth.md)
<!-- used-by:end -->
