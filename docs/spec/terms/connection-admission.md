---
id: connection-admission
title: Connection admission
kind: term
status: draft
aliases: [admitted, refusal]
defined_for: realtime-topic-stream
rules_hash: 9c60a0f1c99d
---
# Connection admission
## Definition
Connection admission is the check the [hub](realtime-hub.md) runs before it opens the [stream](stream-frame.md). A connection is admitted for all requested [topics](realtime-topic.md) or for none, so there is never a partial stream. [An anonymous viewer](viewer.md) who is refused gets `401`, and an authenticated viewer who is refused gets `403`. The `403` for someone else's topic is identical to the one for a missing topic, which stops callers from discovering which topics exist (design intent, not stated in the spec).

## Example
A signed-in user asks for [`user:42`](realtime-topic.md) (their own) and `user:99` (someone else's). Both IDs are illustrative. The answer is `403`, and no events from either topic are delivered.
The user-level and instance-level connection limits can also refuse a connection, with [`429 too_many_connections`](too-many-connections.md) and [`503 realtime_capacity`](realtime-capacity.md).

## Known gaps
- The spec does not say what body a refusal response carries.
- The spec does not say whether access is checked again after admission. [`revoke`](session-revocation.md) exists, but its API is described only on the S51 page.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-14, R-21, R-31
- [realtime-topic-stream](../concepts/realtime-topic-stream.md): C-03
- [default-deny-topic](default-deny-topic.md)
- [event-payload](event-payload.md)
- [invalid-query](invalid-query.md)
- [invalid-topics](invalid-topics.md)
- [realtime-hub](realtime-hub.md)
- [realtime-policy-unavailable](realtime-policy-unavailable.md)
- [realtime-revoke](realtime-revoke.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [realtime-topic](realtime-topic.md)
- [sliding-window-estimate](sliding-window-estimate.md)
- [stream-frame](stream-frame.md)
- [viewer](viewer.md)
<!-- used-by:end -->
