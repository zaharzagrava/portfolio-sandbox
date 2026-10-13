---
id: relay-cdc-mode
title: CDC relay mode
kind: term
status: draft
aliases: [cdc, cdc mode, relay mode]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# CDC relay mode
## Definition
CDC relay mode is the `cdc` setting of the [outbox relay](outbox-relay.md). In this mode, [Debezium ↗](../sw-external-terms.md#change-data-capture) reads new outbox rows from the database's change log and publishes them to Kafka. It does not poll the outbox table. Debezium uses the [outbox connector configuration](outbox-connector-configuration.md), which captures only the outbox table. The [poller](relay-poller-mode.md) and CDC must produce identical messages, so choosing `cdc` or `poller` is only a configuration choice. Startup fails if the relay mode is invalid.

## Example
Relay mode is set to `cdc`. An order transaction commits and appends one event row to the outbox. Debezium picks the row up from the change log and publishes it to `orders.events`, keyed by the order's `[aggregateId](aggregate-id.md)`. The message has the same envelope and the same `eventId`, `type`, `version` and `[traceparent ↗](../sw-external-terms.md#traceparent)` headers that the poller would send.

## Known gaps
- The spec does not say how a row published through CDC gets marked published. The outbox purge job deletes only published rows, so it is unclear whether CDC-published rows are ever purged.
- The spec does not say whether the lease, the full-jitter backoff, parking and holding back later rows of the same aggregate also apply in `cdc` mode. The rules describe them only for the relay in general.
- The spec does not say how task rows reach their queue in `cdc` mode. The connector rule mentions only routing by the row's topic.

## Used by
<!-- used-by:start -->
- [outbox-connector-configuration](outbox-connector-configuration.md)
- [outbox-relay](outbox-relay.md)
- [relay-poller-mode](relay-poller-mode.md)
<!-- used-by:end -->
