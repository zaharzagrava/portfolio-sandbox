---
id: realtime-subscription
title: Realtime subscription
kind: term
status: draft
aliases: [subscriptions]
defined_for: S51-realtime-push
rules_hash: 5af320f4b07a
---
# Realtime subscription
## Definition
A realtime subscription is the hub's record that a stream connection, or an in-process listener, wants the events of one realtime topic. It exists after connection admission and lasts until the connection closes or a revoke ends it. When a request names a topic twice, the hub keeps only one subscription for it. On each instance, all subscriptions to the same topic share one realtime backplane subscription through ref-counted fan-out. If the subscribe step fails, the hub leaves no subscription behind.

## Example
A browser calls `GET /api/streams?topics=user:<A>,user:<A>`. The hub creates one subscription to `user:<A>`, not two. Later, `revoke({ prefix: "shop", id: "X" })` with no `userId` ends every subscription to `shop:X:*` on every instance, and each viewer gets a `revoked` frame.

## Known gaps
- The spec does not say how a subscription made with `subscribe(topic, handler)` is ended. No tagged test covers the rules for the in-process subscriber.
- Not confirmed in the code: when a revoke removes only some of a connection's topics, whether the connection stays open for the rest. Only the case where the revoked topic is the last one is described: the response then ends.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-02, R-27
- [invalid-query](invalid-query.md)
- [invalid-topics](invalid-topics.md)
<!-- used-by:end -->
