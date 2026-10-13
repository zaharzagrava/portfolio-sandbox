---
id: baseline-frame
title: Baseline frame
kind: term
status: draft
aliases: [baseline]
defined_for: S51-realtime-push
rules_hash: 575e715293e1
---
# Baseline frame
## Definition
A baseline frame is the first frame a client receives when it connects without a [replay cursor](replay-cursor.md). No historical data events come with it, so a fresh client starts from "now" rather than receiving the [buffer](replay-buffer.md)'s history. Design intent (not stated in the spec): the baseline gives the client a starting cursor, so a later reconnect replays only what it missed.

## Example
The browser opens `GET /api/streams?topics=user:<A>` with no [`Last-Event-ID` ↗](../sw-external-terms.md#last-event-id) header. It gets a baseline frame first, then only events published after that point.

## Known gaps
- The spec does not say what the baseline frame contains, such as its event name, whether it carries an [`id:`](sse-event-id.md), or its data shape.
- Not confirmed in the code: a reconnect after a baseline ([AS-14](acceptance-scenario.md)) has no test, so resuming from a baseline is unproven.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-09
- [acceptance-scenario](acceptance-scenario.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
- [unusable-cursor-entry](unusable-cursor-entry.md)
<!-- used-by:end -->
