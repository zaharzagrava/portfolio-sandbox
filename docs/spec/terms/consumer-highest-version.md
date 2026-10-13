---
id: consumer-highest-version
title: Consumer's highest supported version
kind: term
status: draft
aliases: [highest version]
defined_for: S53-events-projections
rules_hash: f2bb04ceb8fe
---
# Consumer's highest supported version
## Definition
The consumer's highest supported version is the newest version of an event type that a given [event consumer](event-consumer) knows how to handle. The [relay](outbox-relay.md) sends each event's version in the `version` header, and every `(type, version)` pair is unique. When an event arrives with a version above this ceiling, the consumer [dead-letters ↗](../sw-external-terms.md#dead-letter-queue) it with [`UNSUPPORTED_VERSION`](unsupported-version). Events at or below the ceiling are processed as usual.

## Example
A consumer's highest supported version for `fixtures.item_changed` is 2 (illustrative). An incoming message has the header `version: 3`. That message goes to [`<consumer>.dlq` ↗](../sw-external-terms.md#dead-letter-queue) with [`UNSUPPORTED_VERSION`](unsupported-version.md).

## Known gaps
- The spec does not say how a consumer declares its highest version. It might be read from its registered handlers or set as an explicit setting.
- The spec does not say whether "version" here always means the event-type version (the `version` header) and never [aggregateVersion](aggregate-version). The pairing with `(type, version)` in S53.R-02 suggests it means the event-type version.
- The spec does not say whether a consumer must also handle all older versions, or only the latest.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-11
- [outbox-relay](outbox-relay.md)
<!-- used-by:end -->
