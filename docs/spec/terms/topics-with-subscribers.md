---
id: topics-with-subscribers
title: topicsWithSubscribers
kind: term
status: draft
aliases: []
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# topicsWithSubscribers
## Definition
`[topics](realtime-topic.md)WithSubscribers` is a [hub method](realtime-hub.md) that a domain calls to learn which topics of one [route](realtime-route.md) have [viewers](realtime-subscription.md) right now. It checks every instance, not only the one making the call. It returns only topics that match the given prefix and optional suffix exactly, sorted, and it stops at a cap and logs a warning. If the realtime store cannot be reached, it rejects with [`RealtimeUnavailableError`](realtime-unavailable.md) within a time limit instead of waiting.

## Example
Suppose a domain wants to push updates only to shops that someone is watching (values are illustrative):
```ts
const topics = await realtimeSubscriptions.topicsWithSubscribers('shop', 'orders');
// e.g. ['shop:A:orders', 'shop:X:orders'], sorted; shops with no viewer are not listed
```

## Known gaps
- The spec does not say how prefix and suffix combine into a route, or whether the suffix also matches topics that have no suffix.
- The spec does not say which topics are dropped when the cap is reached, or where the warning goes (log, metric or return value).
- The spec does not say how quickly a viewer who just disconnected stops appearing, so the result may include a topic that no longer has a viewer.

## Used by
<!-- used-by:start -->
- [realtime-hub](realtime-hub.md)
- [realtime-route](realtime-route.md)
- [realtime-subscription](realtime-subscription.md)
<!-- used-by:end -->
