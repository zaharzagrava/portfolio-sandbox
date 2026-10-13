---
id: realtime-route
title: Realtime route
kind: term
status: draft
aliases: [routes]
defined_for: S51-realtime-push
rules_hash: 7aa3e77a8191
---
# Realtime route
## Definition
A realtime route is the shape shared by a family of [realtime topics](realtime-topic.md), such as all per-user topics or all per-shop topics. A domain registers each route once with [`define`](topic-registry.md) on the topic registry while modules initialize, and gives it one [topic access rule](realtime-topic-access-rule.md). Each route can be registered only once. [The registry freezes after startup](topic-registry-frozen.md), so no route can be added later. Other [hub methods](realtime-hub.md) also work on a whole route: `topicsWithSubscribers` lists a route's topics that have viewers, and [`revoke`](realtime-revoke.md) ends matching [subscriptions](realtime-subscription.md).

## Example
`user:<A>` and `user:<B>` are two topics of the same per-user route. The route's rule refuses user B on `user:<A>` (`403`) and refuses an [anonymous viewer](viewer.md) (`401`).
```ts
// illustrative: the topics of one route that have a viewer on any instance
const topics = await realtimeSubscriptions.topicsWithSubscribers('shop', 'orders');
```
A route is identified by a prefix and an optional suffix, with a per-topic id between them. This reading comes from the `revoke({ userId?, prefix, id, suffix? })` and `topicsWithSubscribers(prefix, suffix?)` signatures. Design intent (not stated in the spec): one rule per route means a domain never has to register each user's or shop's topic separately.

## Known gaps
- The spec does not say how a route is written: the arguments of `define`, the separator, or exactly how prefix, id and suffix make a topic name.
- The spec does not say what happens when a client asks for a topic that matches no registered route.
- Not confirmed in the code: that "two definitions of the same route" compares only prefix and suffix, and not also the rule.

## Used by
<!-- used-by:start -->
- [realtime-hub](realtime-hub.md)
- [realtime-subscription](realtime-subscription.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [topic-registry-frozen](topic-registry-frozen.md)
- [topics-with-subscribers](topics-with-subscribers.md)
- [viewer](viewer.md)
<!-- used-by:end -->
