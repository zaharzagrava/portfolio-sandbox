---
id: too-many-connections
title: too_many_connections (429)
kind: term
status: draft
aliases: [too_many_connections]
defined_for: realtime-topic-stream
rules_hash: e3b0c44298fc
---
# too_many_connections (429)
## Definition
`too_many_connections` is the error [the stream endpoint](stream-connection.md) returns with HTTP `429` when one user already holds the maximum number of [open stream connections](stream-connection.md). It is a per-user limit. It is separate from [`503 realtime_capacity`](realtime-capacity.md), which an instance returns when the instance as a whole is full. Design intent (not stated in the spec): the limit stops one user, for example with many open tabs, from using up shared stream capacity.

## Example
A user already has 20 streams open on [`user:{userId}`](realtime-topic.md) across tabs and devices. A 21st request to the stream endpoint is refused with `429` and code `too_many_connections`. No events are sent on it.

## Known gaps
- The spec does not say whether the per-user count covers the whole fleet or each instance separately.
- The spec does not say whether the response includes [`Retry-After` ↗](../sw-external-terms.md#retry-after) or any [extension members](extension-members.md).

## Used by
<!-- used-by:start -->
- [extension-members](extension-members.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
