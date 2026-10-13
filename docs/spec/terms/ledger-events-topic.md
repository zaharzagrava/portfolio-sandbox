---
id: ledger-events-topic
title: ledger.events topic
kind: term
status: draft
aliases: [ledger.events]
defined_for: S14-ledger-reconciliation
rules_hash: 510099fe11ed
---
# ledger.events topic
## Definition
`ledger.events` is the [event backbone](event-backbone.md) topic the ledger publishes its events on. Its known event is [`ledger.journal_posted` v2](ledger-journal-posted-event.md): there is one per [posted journal](ledger-journal.md), written through [the outbox](inbox-table.md) in the posting's transaction. Other domains learn about ledger postings from this topic and never read ledger tables directly. The known consumer is the `BalanceProjector`, [consumer group](consumer-group.md) `ledger-balances`, which feeds the [balance read model](read-model.md).

## Example
A [`SALE`](journal-kind.md) posted by [`recordPaymentCaptured`](record-payment-captured.md) commits together with its outbox row. The [outbox relay](outbox-relay.md) then publishes one `ledger.journal_posted` v2 event on `ledger.events`. The `BalanceProjector` in group `ledger-balances` consumes that event.

## Known gaps
- The spec does not say whether [`ledger.reconciliation_completed`](ledger-reconciliation-completed-event.md) and [`ledger.reconciliation_issue_opened`](ledger-reconciliation-issue-opened-event.md) are also published on `ledger.events`, or on another topic.
- The spec does not give the event key (partitioning key) for this topic. So nothing stated guarantees the order of events for one account. Consumers rely on [balance versions](balance-version.md) for ordering instead.
- The spec does not say whether v1 events still appear on the topic.

## Used by
<!-- used-by:start -->
- [balance-projector](balance-projector.md)
- [balance-version](balance-version.md)
- [consumer-group](consumer-group.md)
- [event-backbone](event-backbone.md)
- [inbox-table](inbox-table.md)
- [ledger-journal-posted-event](ledger-journal-posted-event.md)
- [ledger-journal](ledger-journal.md)
- [outbox-relay](outbox-relay.md)
- [read-model](read-model.md)
<!-- used-by:end -->
