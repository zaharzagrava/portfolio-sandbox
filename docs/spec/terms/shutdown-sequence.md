---
id: shutdown-sequence
title: Shutdown sequence
kind: term
status: draft
aliases: [sequence]
defined_for: S54-platform-toolkit
rules_hash: 66c0603098e5
---
# Shutdown sequence
## Definition
The shutdown sequence is the ordered set of steps an app runs when it receives [SIGTERM ↗](../sw-external-terms.md#termination-signal) or SIGINT, built by [`createGracefulShutdown`](create-graceful-shutdown.md). In an HTTP app, [readiness](readiness.md) turns false first and a short wait passes. Then the server stops accepting, requests already being handled finish within a time limit, and the registered cleanup steps run in ascending order, and a failing step does not stop the sequence. If an overall time limit for shutting down passes, the process is forced to exit. Operators rely on this to let apps finish their work and restart without dropping requests.

## Example
```
SIGTERM → readiness false → drain delay → stop accepting
        → in-flight requests finish → tasks in ascending order → exit
```
A worker with no HTTP server skips the HTTP steps. It stops its consumer, flushes, closes pools and exits 0.

## Known gaps
- The spec does not say what happens if a second SIGTERM or SIGINT arrives while the sequence is already running.
- The spec does not say the exit code of a clean HTTP app shutdown. Exit 0 is stated only for the worker case, and exit 1 only after a task failure or forced shutdown.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-11
- [crash-handlers](crash-handlers.md)
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [hard-shutdown-timeout](hard-shutdown-timeout.md)
- [in-flight-request](in-flight-request.md)
- [management-listener](management-listener.md)
- [readiness](readiness.md)
- [request-drain-timeout](request-drain-timeout.md)
- [shutdown-task](shutdown-task.md)
- [shutdown-tasks](shutdown-tasks.md)
- [socket-destruction](socket-destruction.md)
- [start-management-listener](start-management-listener.md)
<!-- used-by:end -->
