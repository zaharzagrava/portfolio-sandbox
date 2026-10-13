---
id: socket-destruction
title: Socket destruction
kind: term
status: draft
aliases: [destroyed request, socket is destroyed]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# Socket destruction
## Definition
Socket destruction is how the [shutdown sequence](shutdown-sequence.md) handles a request that is still [in flight](in-flight-request.md) when the [request-drain timeout](request-drain-timeout.md) runs out. The platform closes that request's connection without waiting for the handler. It then logs `shutdown_request_drain_timeout` and the sequence goes on to the [shutdown tasks](shutdown-tasks.md). This way one stuck handler cannot block the shutdown. That reason is design intent (not stated in the spec).

## Example
A handler never finishes. [SIGTERM ↗](../sw-external-terms.md#termination-signal) arrives. [Readiness](readiness.md) turns false, the drain delay passes and the server stops accepting new requests. After the request-drain timeout (500 ms in the scenario), the stuck request's socket is destroyed, `shutdown_request_drain_timeout` is logged, and the shutdown tasks start.

## Known gaps
- The spec does not say what the client of a destroyed request receives, for example a partial response, an error or only a dropped connection.
- The spec does not say whether the handler's work stops when its socket is destroyed. For example, an open transaction scope might still commit afterwards.
- The spec does not say whether a request-drain timeout changes the process exit code. Exit code 1 is stated only for failed or timed-out shutdown tasks and for the hard timeout.

## Used by
<!-- used-by:start -->
- [in-flight-request](in-flight-request.md)
- [readiness](readiness.md)
- [request-drain-timeout](request-drain-timeout.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-tasks](shutdown-tasks.md)
<!-- used-by:end -->
