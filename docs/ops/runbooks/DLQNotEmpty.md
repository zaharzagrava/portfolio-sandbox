# DLQNotEmpty / JobQueueLagging

**Severity:** ticket · **Owner:** owner of the queue's consumer · **Dashboards:** *Async* → Dead-letter queues, Job queue lag

## What it means
Messages failed `maxReceiveCount` times and were parked. That work (webhook delivery, media processing, KYC extraction, imports, document ingestion) is not happening for those items.

## Triage
1. Which queue? Panel "Dead-letter queues" (`sqs_queue_messages{dlq="true"}`).
2. Peek without deleting: `aws sqs receive-message --queue-url <dlq> --max-number-of-messages 5 --visibility-timeout 0`.
3. Same error for all? Logs/traces of the consumer with the message id; Lambda: CloudWatch Logs Insights `fields @message | filter level = "error"`.

## Mitigate
- **Bug:** fix and deploy, then redrive: `aws sqs start-message-move-task --source-arn <dlq-arn>` (consumers are idempotent by design, so redrive is safe).
- **Poison input** (corrupt file): mark the domain object failed (most handlers already do), then delete those messages.
- **Downstream outage** (provider down): wait for recovery, then redrive.
- Jobs lagging (`job_queue_lag_seconds`): scale workers; check one job type isn't hogging (per-type concurrency caps).

## Verify
DLQ visible = 0; source queue drains; no new DLQ arrivals for 1 h.
