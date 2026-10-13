---
id: idle-timeout
title: Idle timeout
kind: term
status: draft
aliases: [configured idle timeout]
defined_for: S35-trending
rules_hash: 0b35eded4ce5
---
# Idle timeout
## Definition
The idle timeout is how long a [partition ↗](../sw-external-terms.md#kafka-partition) of [`analytics.events`](analytics-events-topic.md) can go without events before the [trending consumer](event-consumer.md) treats it as an [idle partition](idle-partition.md). Once a partition passes it, the consumer stops waiting for new events to move that partition's [watermark](watermark.md) and moves it with the wall clock instead. This lets windows on a quiet partition close and merge into the trending aggregate. Its value is one of the `TRENDING_*` configuration variables.

## Example
Partition 3 gets its last `product_view` at `11:05:10`, and the idle timeout is 30 s (the configured default). If no event arrives by about `11:05:40`, partition 3 counts as idle. From then on, the wall clock drives its watermark, so its open minute windows can still close. (The partition number and times are illustrative.)

## Known gaps
- The spec does not say whether idle time is measured from when the last event was received or from that event's event time.
- The spec does not say whether the wall-clock watermark still subtracts the lateness margin, or what happens when events start arriving again on an idle partition.
- Not confirmed in the code: the exact name of the `TRENDING_*` variable for the idle timeout. The facts only point to `trending-config.ts#TRENDING_DEFAULTS` and `tumbling-windows.ts#PartitionWindows`.

## Used by
<!-- used-by:start -->
- [event-consumer](event-consumer.md)
- [idle-partition](idle-partition.md)
- [trending-configuration](trending-configuration.md)
- [watermark](watermark.md)
<!-- used-by:end -->
