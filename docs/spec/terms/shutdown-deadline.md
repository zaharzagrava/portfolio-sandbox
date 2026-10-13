---
id: shutdown-deadline
title: Shutdown deadline
kind: term
status: draft
aliases: [deadline]
defined_for: S35-trending
rules_hash: 4e81219e176b
---
# Shutdown deadline
## Definition
The shutdown deadline is the time the trending consumer has to stop cleanly after it receives a [termination signal ↗](../sw-external-terms.md#termination-signal). Within that time, it [merges](window-merge.md) every [open window](trending-window.md) and [commits the offsets ↗](../sw-external-terms.md#kafka-offset-commit) that match those merges, then exits. This keeps the ranking up to date across deploys. Even when windows are not merged before exit, the [commit floor](commit-floor.md) still prevents data loss on restart. Design intent (not stated in the spec): flushing at shutdown avoids rebuilding open windows from the earliest unmerged offset on the next start.

## Example
Illustrative: during a deploy the consumer receives `SIGTERM` with three open windows. It merges all three, commits the offsets that match those merges, and exits before the deadline (S35.B-16).

## Known gaps
- The spec does not say how long the deadline is. No `TRENDING_*` variable listed among the configuration defaults covers it.
- The spec does not say what happens when the deadline passes with merges still unfinished (for example, while the [aggregate store](trending-aggregate.md) is down). It only implies that recovery falls back to rebuilding from the commit floor.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-16
- [S49](../capabilities/S49-job-scheduler.md): B-10, B-11
- [commit-floor](commit-floor.md)
- [job-stop-signal](job-stop-signal.md)
- [realtime-config](realtime-config.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-window](trending-window.md)
- [window-merge](window-merge.md)
<!-- used-by:end -->
