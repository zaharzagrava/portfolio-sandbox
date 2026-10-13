---
id: relay-poller-mode
title: Poller relay mode
kind: term
status: draft
aliases: [poller, poller mode]
defined_for: S53-events-projections
rules_hash: c72d882b1bd9
---
# Poller relay mode
## Definition
`poller` is one of the two [outbox relay modes](outbox-relay.md); the other is [`cdc` ↗](../sw-external-terms.md#change-data-capture). In this mode, each replica polls the [outbox table](inbox-table.md) on a local ticker, [claims pending rows under a lease](job-claim.md), publishes them, and marks them published. Exactly one poller runs per process. The [lease](concurrency-lease.md) stops two replicas from publishing the same row while it holds. The messages are identical to those from CDC mode, so choosing a mode is only a configuration decision.

## Example
There are two replicas in `poller` mode and 100 pending rows. Both drain at once, and the log ends up with exactly 100 messages (from S53.B-06). An invalid mode value such as `pollr` (illustrative) makes startup fail.

## Known gaps
- The spec does not say what the configuration key for the relay mode is called, or the ticker interval.
- The spec only explains why the poller is a local ticker and not a scheduled job by citing S49 FR-060.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-14
- [concurrency-lease](concurrency-lease.md)
- [event-key](event-key.md)
- [inbox-table](inbox-table.md)
- [job-claim](job-claim.md)
- [outbox-connector-configuration](outbox-connector-configuration.md)
- [outbox-relay](outbox-relay.md)
- [relay-cdc-mode](relay-cdc-mode.md)
<!-- used-by:end -->
