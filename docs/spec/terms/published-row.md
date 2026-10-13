---
id: published-row
title: Published row (outbox)
kind: term
status: draft
aliases: [published, published rows]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# Published row (outbox)
## Definition
A published row is an [outbox row](event-row.md) that the [outbox relay](outbox-relay.md) has sent to Kafka and then marked as published. It is the normal end state of a [pending row](pending-row.md). Only published rows are deleted by the [outbox purge job](outbox-purge-job.md). A [parked row](parked-row.md) is not published, so the purge job does not delete it. A row is marked published after the send, so a crash between the send and the mark leaves it pending, and it is sent again as a duplicate.

## Example
1. A transaction appends `fixtures.item_changed` for aggregate A, so one pending row exists (S53.B-01).
2. The relay sends it to `fixtures.events`, keyed by A's `[aggregateId](aggregate-id.md)`, and marks the row published.
3. More than 7 days later, the purge job deletes the row in a batch of at most 1,000 rows (S53.R-15).

## Known gaps
- The spec does not say whether "older than 7 days" counts from when the row was published or from when it was appended.
- The spec does not say which column or value marks a row as published.
- The spec does not say whether a published row can go back to pending. [Replay](event-replay.md) reads the Kafka log, not the outbox table.

## Used by
<!-- used-by:start -->
- [bounded-batch](bounded-batch.md)
- [event-replay](event-replay.md)
- [event-row](event-row.md)
- [outbox-purge-job](outbox-purge-job.md)
- [outbox-relay](outbox-relay.md)
- [parked-row](parked-row.md)
- [pending-row](pending-row.md)
<!-- used-by:end -->
