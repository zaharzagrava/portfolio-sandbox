---
id: local-queue-configuration
title: Local queue configuration
kind: term
status: draft
aliases: [elasticmq.conf]
defined_for: J02-seller-to-first-sale
rules_hash: 528702391f66
---
# Local queue configuration
## Definition
The local queue configuration is the [ElasticMQ ↗](../sw-external-terms.md#sqs-queue) file that sets up the [SQS-compatible queue ↗](../sw-external-terms.md#sqs-queue) on the [local stack](local-provider-doubles.md). That queue carries [document-extraction commands](extraction-message.md) from onboarding to the [extractor](extraction-worker.md). It is the only code file the [J02 journey](main-journeys.md) lists as its own. The journey owns no queues; it only configures the local copy so the hand-offs can run.

## Example
The file is `infra/docker/elasticmq/elasticmq.conf`. In J02 AS-10, the extractor is stopped and the seller marks documents uploaded. The documents stay [`QUEUED`](document-status.md) and onboarding stays [`SUBMITTED`](onboarding-application-status.md) until the extractor returns and reads the waiting commands.

## Known gaps
- The spec does not say which queues the file declares, their names, or settings such as [visibility timeout ↗](../sw-external-terms.md#sqs-visibility-timeout) and [dead-letter routing](dead-letter-topic.md).
- The spec does not say whether production uses real SQS with the same queue definitions, or how the two are kept in step.

## Used by
<!-- used-by:start -->
- [catalog-imports-queue](catalog-imports-queue.md)
- [dead-letter-topic](dead-letter-topic.md)
- [extraction-message](extraction-message.md)
- [extraction-worker](extraction-worker.md)
- [local-provider-doubles](local-provider-doubles.md)
- [main-journeys](main-journeys.md)
- [webhook-receiver-allow-list](webhook-receiver-allow-list.md)
<!-- used-by:end -->
