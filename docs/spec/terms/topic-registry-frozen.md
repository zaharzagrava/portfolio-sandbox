---
id: topic-registry-frozen
title: Registry freeze
kind: term
status: draft
aliases: [frozen, topicregistryfrozenerror]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# Registry freeze
## Definition
The registry freeze is the point after startup when the [topic registry](topic-registry.md) stops accepting new definitions. Before the freeze, domains call [`define(...)`](topic-registry.md) to register their [topic routes](realtime-topic.md) and [access rules](realtime-topic-access-rule.md). After it, any `define` call throws `TopicRegistryFrozenError` (S51.R-28). This fixes the full set of routes and rules before [viewers](viewer.md) are admitted. That reason is design intent (not stated in the spec).

## Example
During module initialization, a domain calls `define(...)` for its `user:` route, and the call succeeds. Later, while the app is serving requests, some code calls `define(...)` for a new route (illustrative). That call throws `TopicRegistryFrozenError`, and the route is not registered.

## Known gaps
- The spec does not say exactly when startup ends and the freeze starts, for example whether it happens before the instance accepts its first stream connection.
- The spec does not say whether the error is only thrown or also logged or counted in metrics.

## Used by
<!-- used-by:start -->
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [topic-registry](topic-registry.md)
- [viewer](viewer.md)
<!-- used-by:end -->
