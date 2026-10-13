---
id: realtime-unavailable
title: realtime_unavailable (503)
kind: term
status: draft
aliases: [realtime_unavailable]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# realtime_unavailable (503)
## Definition
`realtime_unavailable` is the [problem+json ↗](../sw-external-terms.md#problem-json) refusal the [stream endpoint](stream-connection.md) returns with status `503` when the [hub](realtime-hub.md) cannot subscribe to the [backplane](realtime-backplane.md) for a requested [topic](realtime-topic.md). Admission waits for the backplane to confirm the subscription, so a failure is detected before the stream opens. The refusal leaves no state behind: no [ref-count](ref-counted-fan-out.md), no partial subscription and no open stream. It differs from `realtime_capacity` (instance full) and `realtime_policy_unavailable` (rule failed).

## Example
The backplane is unreachable when a client calls `GET /api/streams?topics=user:<A>`. The client gets `503` with code `realtime_unavailable`. A later retry, once the backplane is back, is admitted normally.

## Known gaps
- The spec does not say whether this response carries a `Retry-After` header.
- The spec does not say whether a failure on one topic undoes backplane subscriptions already confirmed for the other topics of the same request. "Leave no state" suggests it does, but this is not stated.

## Used by
<!-- used-by:start -->
- [realtime-backplane](realtime-backplane.md)
- [realtime-hub](realtime-hub.md)
- [realtime-topic](realtime-topic.md)
- [ref-counted-fan-out](ref-counted-fan-out.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
