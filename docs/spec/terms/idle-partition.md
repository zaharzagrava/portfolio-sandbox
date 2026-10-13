---
id: idle-partition
title: Idle partition
kind: term
status: draft
aliases: [partition]
defined_for: S35-trending
rules_hash: 9d4731a83034
---
# Idle partition
## Definition
An idle [partition ↗](../sw-external-terms.md#kafka-partition) is a partition of [`analytics.events`](analytics-events-topic.md) that has received no events for a set length of time. Normally only incoming events move a partition's [watermark](watermark.md), so a quiet partition would leave its [windows](trending-minute-window.md) open indefinitely. The consumer therefore advances an idle partition's watermark using the [wall clock ↗](../sw-external-terms.md#wall-clock), so its windows still close and merge. Design intent (not stated in the spec): without this, [offsets ↗](../sw-external-terms.md#kafka-offset-commit) on a quiet partition could not commit past its open windows.

## Example
Illustrative: partition 3 receives its last event at `11:05:10`, and the configured idle timeout is 30 s. From about `11:05:40`, partition 3's watermark follows the wall clock. Its `11:05–11:06` window closes once the watermark passes `11:06:00`, even though no new events arrive.

## Known gaps
- The spec does not say whether the wall-clock watermark also subtracts the [lateness margin](late-event-horizon.md), or what happens when events start arriving again on a partition that was idle.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): R-16
- [allowed-lateness](allowed-lateness.md)
- [analytics-events-topic](analytics-events-topic.md)
- [idle-timeout](idle-timeout.md)
- [late-event-horizon](late-event-horizon.md)
- [trending-minute-window](trending-minute-window.md)
- [trending-score](trending-score.md)
- [watermark](watermark.md)
<!-- used-by:end -->
