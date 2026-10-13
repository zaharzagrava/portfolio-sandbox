---
id: realtime-revoke
title: revoke
kind: term
status: draft
aliases: []
defined_for: realtime-topic-stream
rules_hash: 46d7b152f465
---
# revoke
## Definition
`revoke` is part of the API of the [realtime hub](realtime-hub.md), and [S51](../capabilities/S51-realtime-push.md) owns it. S51 defines it together with the stream endpoint, [`publish`](realtime-publish.md), the in-process subscriber, replay and the [topic access rules](realtime-topic-access-rule.md). The spec does not describe what `revoke` does. The name suggests it withdraws a viewer's access to a topic or a stream connection after [connection admission](connection-admission.md). That reading is design intent (not stated in the spec).

## Example
S51 defines `revoke` as part of the hub, next to `publish`. Unlike S13, which calls `publish` for `payment.status`, no capability is shown calling `revoke`.
```text
S51 hub API: stream endpoint, publish, in-process subscriber, replay, access rules, revoke
```

## Known gaps
- The spec does not say what `revoke` takes as input, what it returns, or what it does to stream connections that are already open. Only the S51 page has these details.
- The spec does not say which capability calls `revoke`. No capability besides S51 is shown using it.
- The spec does not say whether a revoked viewer gets a closed stream, a `resync` frame, or a refusal when they reconnect.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): B-19
- [connection-admission](connection-admission.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
<!-- used-by:end -->
