---
id: catalog-imports-queue
title: catalog-imports queue
kind: term
status: draft
aliases: [catalog-imports]
defined_for: J04-catalog-sync-to-search
rules_hash: 55910e7596cc
---
# catalog-imports queue
## Definition
`catalog-imports` is the queue that catalog imports run from asynchronously. A completed import waits there until a worker processes it, then streams progress and a [terminal event](terminal-event.md) over [SSE ↗](../sw-external-terms.md#server-sent-events). The catalog import capability ({{cap:S07}}) owns the queue; journey J04 only observes it. If the shop stops being [active](shop-status.md) before the import is processed, the import does not run. Locally, the queue is defined in the [local queue configuration](local-queue-configuration.md) (`infra/docker/elasticmq/elasticmq.conf`).

## Example
The owner of shop `SH` completes an import of file `F1` (60 rows). The work is picked up from `catalog-imports`, and the products then appear in public search.
In another case, an import of `SH` is completed but not yet processed when the admin suspends the shop. The import never runs.

## Known gaps
- The spec does not say what a message on `catalog-imports` contains, or which step puts it there (it only implies "completed but not yet processed").
- The spec does not say how failed messages are retried or [dead-lettered](dead-letter-topic.md).
- The spec does not say how long an import may wait on the queue; the time bounds it refers to (H3, H7 and others) are undefined.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
