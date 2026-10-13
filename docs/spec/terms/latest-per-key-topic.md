---
id: latest-per-key-topic
title: latest-per-key topic
kind: term
status: draft
aliases: [latest-per-key]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# latest-per-key topic
## Definition
A `latest-per-key` topic is a topic where only the newest message for each key needs to be kept. Readers can therefore rebuild state from the last message per [`aggregateId`](aggregate-id.md) alone. Every [event definition](event-definition.md) published to such a topic must carry the full aggregate state ([`carries: state`](carries-state.md)). The capability checks this at startup and refuses the topic with [`TopicPolicyError`](topic-policy-error.md) if any definition breaks the rule. Design intent (not stated in the spec): if older messages for a key can be [compacted ↗](../sw-external-terms.md#kafka-log-compaction) or coalesced away, a message holding only a partial change would lose data.

## Example
Say a topic for an illustrative aggregate type is declared `latest-per-key`, and `fixtures.item_changed` carries only the changed fields rather than the full state. The service fails at startup with `TopicPolicyError` and never starts consuming.

## Known gaps
- The spec does not say how a topic is declared `latest-per-key`, or which other topic policies exist.
- The spec does not say whether this policy maps to Kafka log compaction (`cleanup.policy=compact`). It only says that state-carrying events "allow compaction and coalescing".

## Used by
<!-- used-by:start -->
- [carries-state](carries-state.md)
- [event-definition](event-definition.md)
<!-- used-by:end -->
