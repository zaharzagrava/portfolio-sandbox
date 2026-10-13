---
id: topic-registry
title: Topic registry
kind: term
status: draft
aliases: [define, topicregistry]
defined_for: S51-realtime-push
rules_hash: 1bfd57235811
---
# Topic registry
## Definition
The topic registry holds every [topic route](realtime-topic.md) and the [access rule](realtime-topic-access-rule.md) that admits viewers to it. Each domain calls `define(...)` to register its routes while modules initialize, and if two definitions use the same route, the boot fails. Once startup is over, no more routes can be added, and a later `define` throws `TopicRegistryFrozenError`. A new topic type with no defined rule admits no viewers.

## Example
During module initialization, a domain defines the `user:` route. Its rule admits only the user named in the topic (rule illustrative). User B then asks for `user:<A>` and gets [`403` ↗](../sw-external-terms.md#http-403-forbidden) (S51.B-07). If a second module also defines `user:`, the boot fails.

## Known gaps
- The spec does not say what route grammar `define` accepts or what counts as "the same route". The grammar scenarios (AS-62, AS-64) have no stated rule.
- The spec does not say what `define(...)` takes as arguments, other than a route and its rule.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): R-06
- [default-deny-topic](default-deny-topic.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [topic-registry-frozen](topic-registry-frozen.md)
<!-- used-by:end -->
