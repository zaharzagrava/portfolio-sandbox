---
id: topic-policy-error
title: TopicPolicyError
kind: term
status: draft
aliases: []
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# TopicPolicyError
## Definition
`TopicPolicyError` is the typed error thrown at startup when a topic's declared policy conflicts with the [event definition](event-definition.md)s published to it. The stated case is a [`latest-per-key`](latest-per-key-topic.md) topic with an event definition that does not carry [full aggregate state](carries-state.md). The process refuses to start, so the misconfiguration is caught before any event is published.

## Example
A `latest-per-key` topic includes an event definition without [`carries: state`](carries-state.md) (illustrative). Startup stops with `TopicPolicyError`, and no [relay](outbox-relay.md) or consumer begins work.

## Known gaps
- The spec does not say what the error message contains, for example whether it names the offending topic or event type.
- The spec does not say whether `TopicPolicyError` covers any case besides the `latest-per-key` check.

## Used by
<!-- used-by:start -->
- [carries-state](carries-state.md)
- [event-definition](event-definition.md)
- [outbox-relay](outbox-relay.md)
<!-- used-by:end -->
