---
id: realtime-publish-limit
title: Publish limit
kind: term
status: draft
aliases: [publish timeout]
defined_for: realtime-topic-stream
rules_hash: e3b0c44298fc
---
# Publish limit
## Definition
The publish limit is the longest time [`publish`](realtime-publish.md) waits for the [realtime store](realtime-store.md) to answer. A slower answer counts as a failure, the same as a [store fault](realtime-store.md). In that case `publish` makes no second attempt, does not throw, and [resolves without an id](realtime-publish.md). This means a slow store cannot hold up or break the domain that publishes, such as a payment status transition.

## Example
[S13](../capabilities/S13-payment-intents.md) publishes `payment.status` to the [owner's topic](realtime-topic.md). The store takes 1.5 s to answer (an illustrative value), which is past the 1 s limit in rule C-06. `publish` resolves:
```json
{ "published": false, "id": null }
```
The payment transition goes ahead unchanged.

## Known gaps
- The spec does not say whether `publish` resolves as soon as the limit passes or only when the late answer arrives.
- The spec does not say whether a write that answers too late is cancelled or may still land in the store. If it lands, the event could show up in [replay](replay-buffer.md) even though `publish` reported `published: false`.
- The spec does not say whether the limit can be configured.

## Used by
<!-- used-by:start -->
- [realtime-publish](realtime-publish.md)
- [realtime-store](realtime-store.md)
- [realtime-topic](realtime-topic.md)
- [replay-buffer](replay-buffer.md)
<!-- used-by:end -->
