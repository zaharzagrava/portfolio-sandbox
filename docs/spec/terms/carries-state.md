---
id: carries-state
title: carries: state
kind: term
status: draft
aliases: [carries]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# carries: state
## Definition
`carries: state` is a marker on a [typed event definition](event-definition.md). It says that each event of that type holds the full state of its [aggregate](aggregate-id.md), not only what changed. Because one such event is enough on its own, these events allow [compaction ↗](../sw-external-terms.md#kafka-log-compaction) and [coalescing](latest-per-key-topic.md). Every event definition published to a [latest-per-key topic](latest-per-key-topic.md) must carry it, or startup fails with [`TopicPolicyError`](topic-policy-error.md). Design intent (not stated in the spec): a consumer can rebuild a read model from the newest event per `aggregateId` and ignore older ones.

## Example
Say `fixtures.item_changed` goes to a latest-per-key topic. Each event then holds the whole item at its `aggregateVersion`, not just the edited fields:
```ts
// illustrative shape, not confirmed in the code
{ type: "fixtures.item_changed", version: 1, carries: "state" }
```
If the definition does not carry full state, the service refuses the topic at startup with `TopicPolicyError`.

## Known gaps
- The spec does not say what other values `carries` can take, or what an event without `carries: state` is called (for example, a delta).
- The spec does not say whether "full aggregate state" is checked against the payload schema or only trusted as a declaration.
- Not confirmed in the code: the exact name, place and syntax of the `carries` field on the event definition in `packages/contracts/src/events/`.

## Used by
<!-- used-by:start -->
- [aggregate-id](aggregate-id.md)
- [event-definition](event-definition.md)
- [latest-per-key-topic](latest-per-key-topic.md)
- [topic-policy-error](topic-policy-error.md)
<!-- used-by:end -->
