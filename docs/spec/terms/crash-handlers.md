---
id: crash-handlers
title: Crash handlers
kind: term
status: draft
aliases: [crash handler]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# Crash handlers
## Definition
Crash handlers are process-level listeners for [`unhandledRejection` ↗](../sw-external-terms.md#unhandled-rejection) and [`uncaughtException` ↗](../sw-external-terms.md#uncaught-exception). The [platform toolkit](platform-toolkit.md) installs them with `installCrashHandlers`. When one of these events fires, the handler writes the cause to [stderr ↗](../sw-external-terms.md#stderr) and to the log, then exits the process with a failure code. Design intent (not stated in the spec): after an unexpected error the process state can't be trusted, so it is better to exit and let the platform restart it than to keep running.

## Example
A handler starts an async call and never awaits it, and the call rejects. The process writes the rejection cause to stderr and the log, then exits with code 1 (S54.B-14).

## Known gaps
- The spec does not say whether the [shutdown sequence](shutdown-sequence.md) (drain, [shutdown tasks](shutdown-tasks.md), flush) runs before a crash exit. If it doesn't, buffered data and in-flight requests may be lost.
- The spec does not say when `installCrashHandlers` is called, for example whether [`bootstrapApp`](bootstrap-app.md) calls it. It also doesn't say whether errors thrown before the handlers are installed get the same treatment.

## Used by
<!-- used-by:start -->
- [bootstrap-app](bootstrap-app.md)
- [platform-toolkit](platform-toolkit.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-tasks](shutdown-tasks.md)
<!-- used-by:end -->
