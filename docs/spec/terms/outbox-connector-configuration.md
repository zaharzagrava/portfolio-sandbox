---
id: outbox-connector-configuration
title: Outbox connector configuration
kind: term
status: draft
aliases: [connector, connector configuration]
defined_for: S53-events-projections
rules_hash: 1e446a3cae15
---
# Outbox connector configuration
## Definition
The outbox connector configuration is the [Debezium connector ↗](../sw-external-terms.md#change-data-capture) definition shipped at `infra/debezium/outbox-connector.json`. The relay uses it when it publishes by streaming database changes. It captures only the [outbox table](inbox-table.md). Each row is routed to the topic stored in that row and keyed by its [`aggregateId`](aggregate-id.md). That keeps events of one aggregate in order and makes CDC messages identical to [the poller's](relay-poller-mode.md).

## Example
An outbox row whose topic is `orders.events` is captured from the database log. It is published to `orders.events` with the order's `aggregateId` as the Kafka key, carrying the same envelope and headers the poller would send.

## Known gaps
- The spec does not say how [task rows](task-row.md) are routed to their queue in `cdc` mode. The connector rule mentions only routing by the row's topic.
- Not confirmed in the code: how the connector produces the `eventId`, `type`, `version` and `traceparent` headers that S53.R-09 requires.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-16
- [event-key](event-key.md)
- [inbox-table](inbox-table.md)
- [relay-cdc-mode](relay-cdc-mode.md)
- [relay-poller-mode](relay-poller-mode.md)
- [task-row](task-row.md)
<!-- used-by:end -->
