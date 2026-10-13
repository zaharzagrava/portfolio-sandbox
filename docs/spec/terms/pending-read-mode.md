---
id: pending-read-mode
title: Pending read mode
kind: term
status: draft
aliases: [pending]
defined_for: S53-events-projections
rules_hash: cc8347e4865c
---
# Pending read mode
## Definition
Pending read mode is a per-route setting of the [read-your-writes helper](read-your-writes.md). It controls what a read route returns when the [projection ↗](../sw-external-terms.md#projection) has not yet reached the requested [`minVersion`](min-version.md). In this mode the route does not read from the [write model](write-model.md). It answers `202` with a [`Retry-After` header ↗](../sw-external-terms.md#retry-after), and the client must call again later. Design intent (not stated in the spec): this keeps catch-up reads away from the write model, and the client decides when to try again.

## Example
A route is configured for "pending". The read model's checkpoint is behind the `minVersion` the client asked for. The route answers:
```
HTTP/1.1 202 Accepted
Retry-After: 1
```
A route without this setting acts differently. With the projection stopped at version 6 and `minVersion=7`, it answers `200` with `X-Read-Source: write-model` once the 500 ms read budget runs out.

## Known gaps
- The spec does not say how a route is configured for "pending". It gives no option name and no default, so the write-model fallback looks like the normal behavior.
- The spec does not say whether a "pending" route waits for the read budget before it answers `202`, or answers right away.
- The spec does not say what body, if any, comes with the `202` response.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-17
- [read-wait-timeout](read-wait-timeout.md)
- [read-your-writes](read-your-writes.md)
- [write-model](write-model.md)
<!-- used-by:end -->
