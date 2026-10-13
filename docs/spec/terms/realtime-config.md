---
id: realtime-config
title: realtime.config.ts
kind: term
status: draft
aliases: []
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# realtime.config.ts
## Definition
`realtime.config.ts` is the file that defines the configuration schema for the [realtime hub](realtime-hub.md), exported as `realtimeConfigSchema`. It holds the hub's timing settings: the [heartbeat](job-heartbeat.md), the connection lifetime, the stall limit and the [shutdown drain](shutdown-deadline.md). It also holds the [replay buffer](replay-buffer.md) bounds, the retention, the replay page size, the [connection caps](realtime-instance-limit.md) and the timeouts. The hub reads its limits from this schema, so you won't find them as literals in the stream code.

## Example
These are the timing values the spec lists for this configuration:
```
heartbeat  15 s     (keep-alive on an open [stream connection](stream-connection.md))
lifetime   30 min   (a stream connection closes after this)
stall      30 s     (a blocked write past this closes with [`stalled`](slow-consumer-close.md), S51.R-26)
drain      10 s     (shutdown drain)
retention  1 h      (replay buffer age bound, S51.R-13)
```

## Known gaps
- The spec does not say how these values are set per environment, such as environment variable names or overrides, or whether the listed numbers are defaults or fixed.
- The spec does not give values for the page size, the instance connection limit or the timeouts in this file. It also does not confirm that the buffer bounds here match S51.R-13.
- The spec does not say the lifetime, the shutdown drain or the heartbeat are tested. AS-50 (heartbeat) has no tagged test, and the lifetime and shutdown-drain rules are listed as unproven.

## Used by
<!-- used-by:start -->
- [job-heartbeat](job-heartbeat.md)
- [realtime-hub](realtime-hub.md)
- [realtime-instance-limit](realtime-instance-limit.md)
- [replay-buffer](replay-buffer.md)
- [shutdown-deadline](shutdown-deadline.md)
<!-- used-by:end -->
