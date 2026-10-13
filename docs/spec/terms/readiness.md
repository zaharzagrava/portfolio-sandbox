---
id: readiness
title: Node readiness
kind: term
status: draft
aliases: [ready]
defined_for: S33-autocomplete
rules_hash: 05b750e56096
---
# Node readiness
## Definition
A node reports itself ready even when no [version pointer](version-pointer.md) exists yet at startup. Until a pointer appears, it serves only [catalog completions](catalog-completions.md) and reports [`query_index_unavailable`](degraded-marker.md) in [`degraded`](degraded.md). This means a missing or late build never blocks a node from starting or taking traffic. That this is meant to keep deploys from depending on the build job is design intent (not stated in the spec).

## Example
A fresh environment starts before the first hourly build has run. A call to `GET /api/suggest?q=iph` returns `200` with catalog suggestions and `"degraded": ["query_index_unavailable"]`. Once the pointer appears, a later poll loads the [snapshot](suggest-snapshot.md) and query suggestions start showing up.

## Known gaps
- The spec does not say which health probe endpoint reports this readiness, or what it checks.
- The spec does not say whether a node ever reports not-ready, for example after its snapshot loads keep failing.

## Used by
<!-- used-by:start -->
- [S33](../capabilities/S33-autocomplete.md): B-20
- [S54](../capabilities/S54-platform-toolkit.md): R-19
- [catalog-completions](catalog-completions.md)
- [create-graceful-shutdown](create-graceful-shutdown.md)
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [health-check-criticality](health-check-criticality.md)
- [health-controller](health-controller.md)
- [in-flight-request](in-flight-request.md)
- [request-drain-timeout](request-drain-timeout.md)
- [shutdown-sequence](shutdown-sequence.md)
- [socket-destruction](socket-destruction.md)
- [suggest-index](suggest-index.md)
- [suggest-snapshot](suggest-snapshot.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
