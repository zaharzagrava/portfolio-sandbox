# L06 — Distributed Systems → where it's used

| Topic (notes 06/01–03) | Implemented in | Status |
|---|---|---|
| Queue vs log, fan-out vs competing consumers | D18; SD-17 (Kafka→SQS bridge) | planned |
| SNS → SQS fan-out | O-03 (prod topology for notifications/webhooks), documented local equivalent | planned |
| Idempotent producer, Kafka transactions (EOS) | F-05 producer config; SD-32 aggregator | planned |
| SQS standard vs FIFO, `MessageGroupId`, dedup IDs, visibility, DLQ/redrive, Lambda ESM partial failures | SD-30, SD-03 | planned |
| Partition assignment, consumer groups, rebalancing (cooperative sticky) | F-05 runner config | planned |
| Outbox / inbox | existing #1; F-05 | planned |
| Ordering (per key) | F-05, SD-22, SD-14 | planned |
| Event design (envelope, versioning, thin vs fat) | F-05, SD-30 | planned |
| Consumer backpressure | F-05, SD-09 | planned |
| CAP / PACELC / consistency models (documented per section: strong for holds/bids, eventual for read models) | section Scale blocks + F-05 read-your-writes | planned |
| Sagas (existing #8) + compensations | SD-19 | planned |
| Bidirectional sync, echo suppression, conflicts | SD-36, SD-06 | planned |
| ETL incremental sync | SD-36 | planned |
| Reconciliation | SD-20, SD-32, SD-36 | planned |
| Clocks & ordering (server time authority, HLC) | SD-22, SD-06 | planned |
| Timeouts, retries + jitter + budgets | F-01 | planned |
| Circuit breaker (existing #9), per-endpoint breakers | SD-30, SD-42 | planned |
| Bulkheads | SD-17 per-channel queues, SD-02 noisy neighbours | planned |
| Load shedding & admission control | F-01, SD-21 | planned |
| Fallbacks / graceful degradation | SD-04 partial responses, SD-40 no-discount fallback, SD-42 fallback model | planned |
