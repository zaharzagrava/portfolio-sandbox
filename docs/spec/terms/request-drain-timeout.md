---
id: request-drain-timeout
title: Request-drain timeout
kind: term
status: draft
aliases: [request drain timeout, shutdown_request_drain_timeout]
defined_for: S54-platform-toolkit
rules_hash: 856b38a40f67
---
# Request-drain timeout
## Definition
The request-drain timeout limits how long the [shutdown sequence](shutdown-sequence.md) waits for HTTP requests that are already being handled to finish after the server stops accepting new ones. If a handler is still running when this timeout runs out, the platform forcibly closes that request's connection. It then logs `shutdown_request_drain_timeout` and moves on to the [shutdown tasks](shutdown-tasks.md). [Startup validation](startup-validation.md) checks that the pause before draining begins plus the request-drain timeout is shorter than the overall limit after which the process is forcibly stopped.

## Example
A handler is stuck waiting forever. [SIGTERM ↗](../sw-external-terms.md#termination-signal) arrives. [Readiness](readiness.md) turns false, the drain delay passes and the server stops accepting. After 500 ms the stuck request's socket is destroyed, `shutdown_request_drain_timeout` is logged, and the shutdown tasks start.

## Known gaps
- The spec does not say which configuration key sets this timeout. It is listed only under "shutdown timings".
- The spec does not say what the client of a destroyed request receives, for example whether any partial response or error is sent.
- The spec does not say whether the timeout applies to all in-flight requests together or to each request separately.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-11
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [hard-shutdown-timeout](hard-shutdown-timeout.md)
- [in-flight-request](in-flight-request.md)
- [readiness](readiness.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-tasks](shutdown-tasks.md)
- [socket-destruction](socket-destruction.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
