---
id: viewer
title: Viewer
kind: term
status: draft
aliases: [anonymous viewer, authenticated viewer]
defined_for: realtime-topic-stream
rules_hash: 732c216608ac
---
# Viewer
## Definition
A viewer is the user or browser on the other end of a live connection that receives updates. A viewer is either anonymous or authenticated, and that decides between `401` and `403` when the server refuses to open the connection. Each user may only have a limited number of connections open at once. The number of viewers does not change how much work the shared message-passing layer between instances has to do, because an instance shares [one subscription per topic](realtime-topic.md) across all its viewers.

## Example
A signed-in shopper has checkout open in W03, and their browser is a viewer of [`user:{userId}`](realtime-topic.md). A notification or the payment result appears without a page reload.

## Known gaps
- The spec does not say whether any topic admits anonymous viewers, or how an anonymous viewer is identified.
- The spec does not say whether the connection cap counts a user's connections across all instances or on one instance only.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): B-01
- [S33](../capabilities/S33-autocomplete.md): R-01
- [S34](../capabilities/S34-recommendations.md): R-01, B-01
- [S35](../capabilities/S35-trending.md): R-01, B-01
- [S51](../capabilities/S51-realtime-push.md): R-14, B-10, B-11, B-17, B-20
- [W01](../capabilities/W01-auth-account.md): B-15, B-17
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-03
- [batch-shops-lookup](batch-shops-lookup.md)
- [connection-admission](connection-admission.md)
- [default-deny-topic](default-deny-topic.md)
- [realtime-backplane](realtime-backplane.md)
- [realtime-route](realtime-route.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [stream-connection](stream-connection.md)
- [topic-registry-frozen](topic-registry-frozen.md)
- [user-connection-cap](user-connection-cap.md)
<!-- used-by:end -->
