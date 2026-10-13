---
id: in-flight-request
title: In-flight request
kind: term
status: draft
aliases: [in-flight requests]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# In-flight request
## Definition
An in-flight request is an HTTP request the server has already accepted whose handler has not yet finished. During the [shutdown sequence](shutdown-sequence.md), the server first stops accepting new requests. It then waits for in-flight requests to finish before running the [shutdown tasks](shutdown-tasks.md). The [request-drain timeout](request-drain-timeout.md) limits how long that wait can last. Workers with no HTTP server have no in-flight requests, so their shutdown skips these HTTP steps.

## Example
[SIGTERM ↗](../sw-external-terms.md#termination-signal) arrives while `GET /cart` is still being handled. [Readiness](readiness.md) turns false, the [drain delay](graceful-shutdown-drain.md) passes and the server stops accepting new requests. The `GET /cart` request is in flight, so the sequence waits for it to finish before it runs the shutdown tasks.

## Known gaps
- The spec does not say whether the request-drain timeout applies to all in-flight requests together or to each request separately.
- The spec does not say how the [load-shedding](load-shedding.md) in-flight cap counts in-flight requests. The configuration lists the cap, but no rule describes it and it is untested.

## Used by
<!-- used-by:start -->
- [create-graceful-shutdown](create-graceful-shutdown.md)
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [load-shedding](load-shedding.md)
- [readiness](readiness.md)
- [request-drain-timeout](request-drain-timeout.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-tasks](shutdown-tasks.md)
- [socket-destruction](socket-destruction.md)
<!-- used-by:end -->
