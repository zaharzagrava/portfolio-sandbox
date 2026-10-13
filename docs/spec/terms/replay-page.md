---
id: replay-page
title: Replay page
kind: term
status: draft
aliases: [page boundaries, replay pages]
defined_for: S51-realtime-push
rules_hash: afc80f8e9e76
---
# Replay page
## Definition
A replay page is one batch of stored events that the [hub](realtime-hub.md) reads from the [replay buffer](replay-buffer.md) while it replays to a reconnecting client. The hub keeps reading pages until it reaches the newest event. Events stay in order across page boundaries, with no gap and no duplicate. That includes events published while the replay is running. Page size is part of the hub configuration.

## Example
A client reconnects with a [cursor](replay-cursor.md) at event 1 of a [topic](realtime-topic.md), and 200 events are stored. During the replay, 50 more are published. The client receives events 2 to 250 in order, however many pages that takes (S51.B-04). If a page read fails midway, the connection ends cleanly, with no truncated frame. A reconnect completes the replay (S51.B-18).

## Known gaps
- The spec does not give the page size value. It is only listed as a configuration entry in [`realtime.config.ts`](realtime-config.md).
- The spec does not say how the hub hands over from the last replay page to [live delivery](realtime-publish.md). The facts only imply that the rule against writing a live message at or behind the cursor (S51.R-12) prevents duplicates.

## Used by
<!-- used-by:start -->
- [S51](../capabilities/S51-realtime-push.md): R-07
- [realtime-hub](realtime-hub.md)
- [realtime-publish](realtime-publish.md)
- [realtime-topic](realtime-topic.md)
- [replay-buffer](replay-buffer.md)
- [replay-cursor](replay-cursor.md)
<!-- used-by:end -->
