---
id: create-graceful-shutdown
title: createGracefulShutdown
kind: term
status: draft
aliases: []
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# createGracefulShutdown
## Definition
`createGracefulShutdown` is the platform toolkit function that builds an app's shutdown sequence. It is the entry point for [SIGTERM ↗](../sw-external-terms.md#termination-signal) and SIGINT, so either signal starts the ordered steps. Those steps are: [readiness turns false](readiness.md), [the drain delay](graceful-shutdown-drain.md) passes, the server stops accepting, [in-flight requests](in-flight-request.md) finish, then [shutdown tasks](shutdown-tasks.md) run in ascending order. The [hard shutdown timeout](hard-shutdown-timeout.md) bounds the whole sequence. Product teams use it so they don't write their own signal handling. Design intent (not stated in the spec): every app then drains the same way.

## Example
The code is in `packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts`. When SIGTERM arrives at an HTTP app, the sequence it built runs in this order:
```
readiness false → drain delay → stop accepting → in-flight requests finish → tasks (ascending)
```
If a task fails, later tasks still run and the process exits with code 1.

## Known gaps
- The spec does not say what `createGracefulShutdown` takes as input or returns, or how an app registers its shutdown tasks with it.
- The spec does not say whether `bootstrapApp` calls it automatically or each app must call it.
- Not confirmed in the code: whether the startup timing check (`drain + request drain < hard timeout`) is done inside this function or somewhere else.

## Used by
<!-- used-by:start -->
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [hard-shutdown-timeout](hard-shutdown-timeout.md)
- [in-flight-request](in-flight-request.md)
- [readiness](readiness.md)
- [shutdown-tasks](shutdown-tasks.md)
<!-- used-by:end -->
