---
id: hard-shutdown-timeout
title: Hard shutdown timeout
kind: term
status: draft
aliases: [forced shutdown, hard timeout]
defined_for: S54-platform-toolkit
rules_hash: cb390b5da2a3
---
# Hard shutdown timeout
## Definition
The hard shutdown timeout is the upper limit on how long the whole [shutdown sequence](shutdown-sequence.md) may take. If it passes while the sequence is still running, the process logs `forced shutdown` and [exits 1 ↗](../sw-external-terms.md#exit-code). [Startup validation](startup-validation.md) requires the waiting period at the start of shutdown, before in-flight requests are drained, plus the [request-drain timeout](request-drain-timeout.md) to be shorter than this timeout. This way the hard timeout never cuts off the normal sequence.

## Example
A shutdown task hangs. The sequence is still waiting on it when the hard timeout passes. The process logs `forced shutdown` and exits with code 1.

## Known gaps
- The spec does not say the default value or which configuration key sets it. It is listed only under "shutdown timings".
- The spec does not say whether this timeout is the same thing as the existing "shutdown deadline" term.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-13
- [buffered-data](buffered-data.md)
- [create-graceful-shutdown](create-graceful-shutdown.md)
- [graceful-shutdown-drain](graceful-shutdown-drain.md)
- [request-drain-timeout](request-drain-timeout.md)
- [shutdown-sequence](shutdown-sequence.md)
- [shutdown-tasks](shutdown-tasks.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
