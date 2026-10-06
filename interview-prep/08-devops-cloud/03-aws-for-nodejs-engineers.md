# AWS for Node.js Engineers

The AWS services a Node.js engineer meets most often, plus the questions people usually ask about each.

---

## 1. Compute choices

| | Lambda | ECS Fargate | EKS (K8s) | EC2 |
|---|---|---|---|---|
| Ops burden | lowest | low | high | highest |
| Scaling | per request, to thousands | task-based | pods/nodes | manual/ASG |
| Long-running | ≤ 15 min | yes | yes | yes |
| Cost model | per invocation × duration | per vCPU/GB-hour | cluster + nodes | instances |
| Good for | event-driven (SQS, S3, schedules), spiky low-volume APIs | containers without K8s | many services, platform team, portability | special needs |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LambdaSpec`](../../packages/backend/apps/lambdas/src/lambdas.manifest.ts#L7): The LambdaSpec interface defines each Lambda's SQS queue, timeoutSec, memoryMb, batchSize and maxConcurrency. _(lambdas.manifest.ts)_
> - [`src/main.ts`](../../packages/backend/apps/lambda-local/src/main.ts): The lambda-local main.ts simulates Lambda locally by polling SQS, invoking handlers and handling batch failures with visibility timeouts. · [lambda-local](../../docs/humans/concepts/app-lambda-local/lambda-local.md)
<!-- theory-links:end -->

### Lambda specifics for Node
- **Cold starts**: init code (module loading, SDK clients, DB connections) runs once per execution environment. Keep the bundle small (esbuild tree-shaking, AWS SDK v3 modular clients), initialize clients **outside the handler** so warm invocations reuse them, and use provisioned concurrency for latency-critical paths.
- **Concurrency**: each environment handles **one request at a time**. 1,000 concurrent requests means 1,000 environments, and 1,000 DB connections → use **RDS Proxy**. Use reserved concurrency to cap it and protect downstream.
- **Timeouts**: API Gateway's integration timeout is 29 s by default (it can be raised for regional/private APIs), while Lambda's max is 15 min. For SQS triggers, set the visibility timeout ≥ 6× the function timeout.
- **Idempotency**: every async trigger is at-least-once, so use Powertools for AWS Lambda (TypeScript) **Idempotency** utility (backed by DynamoDB), plus Logger, Tracer, and Metrics.
- Async invocation: built-in retries (2), then **on-failure destinations** or a DLQ.
- Don't keep state in `/tmp` or globals for correctness. Use them only as an optimization.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`LAMBDAS`](../../packages/backend/apps/lambdas/src/lambdas.manifest.ts#L19): The LAMBDAS manifest declares the three Node Lambdas (webhook-delivery, media-processing, document-extractor) with timeout, memory, batch size and max concurrency. _(lambdas.manifest.ts)_
> - [`scripts/build-lambdas.mjs`](../../packages/backend/scripts/build-lambdas.mjs): build-lambdas.mjs compiles the Lambda TypeScript and bundles it with esbuild, which keeps the bundle small and cold starts short.
> - [`nestContext`](../../packages/backend/apps/lambdas/src/shared/nest-context.ts#L12): nestContext caches the Nest application context so warm invocations reuse it instead of re-initializing. _(nest-context.ts)_
<!-- theory-links:end -->

---

## 2. Messaging and integration

- **SQS**: queues, DLQ, FIFO (see the messaging doc).
- **SNS**: pub/sub fan-out. SNS → multiple SQS gives each consumer its own buffer and retries. Message filtering policies.
- **EventBridge**: event bus with rule-based routing (pattern matching on content), schema registry, archive/replay, Scheduler (cron and one-off schedules at scale), Pipes (source → filter → enrich → target).
- **Step Functions**: managed orchestration (saga orchestrator!) with retries, catch, parallel, map, wait states. Standard (exactly-once workflow execution, up to 1 year) vs Express (high volume, at-least-once, 5 min).
- **Kinesis**: streaming (shards), Kafka-like semantics. **MSK** is managed Kafka.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SqsTaskQueue`](../../packages/backend/libs/infrastructure/sqs/sqs-task-queue.ts#L17): SqsTaskQueue is the AWS SQS adapter, with batch enqueue and concurrent consume with heartbeat (visibility extension). _(sqs-task-queue.ts)_
> - [`ConsumeOptions`](../../packages/backend/libs/infrastructure/sqs/task-queue.port.ts#L18): ConsumeOptions sets the SQS concurrency, visibilityTimeoutSec and waitTimeSec for long-polling. _(task-queue.port.ts)_
<!-- theory-links:end -->

---

## 3. Data services

- **RDS / Aurora PostgreSQL**: Aurora has storage separated from compute, up to 15 low-lag replicas, fast failover (~30 s or less), Aurora Serverless v2 (scales ACUs), Global Database. Use **RDS Proxy** for connection pooling (especially with Lambda) and IAM auth. **Performance Insights** shows top SQL and wait events.
- **ElastiCache / MemoryDB**: Redis/Valkey. MemoryDB is durable (multi-AZ transaction log) and can serve as the primary DB.
- **DynamoDB**: key-value/document, single-digit-ms latency at any scale. Design around **access patterns** (single-table design, partition key cardinality, GSIs), conditional writes for optimistic locking, Streams for CDC, TTL. Hot partitions are the main pitfall.
- **S3**: object storage, strong read-after-write consistency (since 2020). **Presigned URLs** for direct browser upload/download, multipart upload for big files, lifecycle rules to cheaper tiers, event notifications to SQS/Lambda/EventBridge, Object Lock for compliance (WORM for financial audit data).
- **OpenSearch**: search and log analytics.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`S3ObjectStorage`](../../packages/backend/libs/infrastructure/storage/s3-object-storage.ts#L21): S3ObjectStorage is the S3/MinIO client with presigned and multipart uploads. _(s3-object-storage.ts)_
> - [`DynamoModule`](../../packages/backend/libs/infrastructure/dynamo/dynamo.module.ts#L14): DynamoModule provides the global DynamoDB service. _(dynamo.module.ts)_ · [dynamo](../../docs/humans/concepts/platform-dynamo/dynamo.md)
<!-- theory-links:end -->

---

## 4. Networking basics they may probe

- **VPC**: public subnets (with an Internet Gateway) vs private subnets (outbound through a **NAT Gateway**, which is expensive: per-GB processing). Use **VPC endpoints** (Gateway endpoints for S3/DynamoDB are free; Interface endpoints for others) to cut NAT cost and keep traffic private.
- Security groups (stateful, per ENI) vs NACLs (stateless, per subnet).
- **ALB** (L7, path/host routing, WAF integration, idle timeout 60 s; mind Node's keepAliveTimeout) vs **NLB** (L4, static IPs, very high throughput, TLS passthrough) vs **API Gateway** (REST/HTTP APIs: auth, throttling, usage plans, request validation; adds cost and latency).
- **CloudFront**: CDN, edge caching, origin shield, signed URLs/cookies, plus WAF and Shield for DDoS.
- Route 53: health checks, failover/latency/weighted routing.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`HealthController`](../../packages/backend/libs/infrastructure/health/health.controller.ts#L15): HealthController serves /livez and /readyz for ALB and Kubernetes health checks. _(health.controller.ts)_ · [health](../../docs/humans/concepts/platform-health/health.md)
<!-- theory-links:end -->

---

## 5. IAM and security

- **Least privilege**: scoped actions **and resources** (`arn:aws:s3:::invoices-bucket/tenant-*`), with conditions.
- Roles over users. No long-lived access keys: **IRSA / EKS Pod Identity** for pods, execution roles for Lambda and ECS tasks, OIDC for CI.
- Policy evaluation: an explicit Deny beats any Allow, and everything is denied by default. SCPs (organization guardrails) and permission boundaries limit what can be granted.
- **KMS**: customer-managed keys, envelope encryption, key policies, automatic rotation.
- **Secrets Manager** (rotation, cross-account) vs **SSM Parameter Store** (cheaper, SecureString).
- **IMDSv2** required on EC2 (SSRF protection).
- **CloudTrail** for API audit, **GuardDuty** for threat detection, **Config** for compliance rules.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`handler`](../../packages/backend/apps/lambdas/src/handlers/media-processing.ts#L48): The media-processing Lambda handler runs under an execution role and writes to S3 and PostgreSQL, so IAM is applied at the Lambda level. _(media-processing.ts)_
<!-- theory-links:end -->

---

## 6. Observability on AWS

- CloudWatch Metrics (custom metrics via the Embedded Metric Format in logs, which is cheap from Lambda), Logs (Insights queries), Alarms (with composite alarms to reduce noise), Synthetics canaries.
- X-Ray / ADOT (the AWS Distro for OpenTelemetry) for tracing.
- Key alarms: SQS `ApproximateAgeOfOldestMessage`, DLQ `ApproximateNumberOfMessagesVisible > 0`, Lambda `Errors`, `Throttles`, `IteratorAge` (streams), RDS `DatabaseConnections`, `FreeStorageSpace`, `ReplicaLag`, `CPUUtilization`, ALB `HTTPCode_Target_5XX_Count`, `TargetResponseTime`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`metric`](../../packages/backend/apps/lambdas/src/shared/telemetry.ts#L10): The metric function writes CloudWatch Embedded Metric Format metrics from the Lambdas. _(telemetry.ts)_
> - [`QueueMetricsService`](../../packages/backend/libs/infrastructure/sqs/queue-metrics.service.ts#L15): QueueMetricsService publishes SQS queue depth and message age as gauges, which matches the oldest-message-age alarm. _(queue-metrics.service.ts)_
<!-- theory-links:end -->

---

## 7. Cost awareness (seniors get asked about this)

- NAT Gateway data processing, cross-AZ data transfer, CloudWatch Logs ingestion (log volume!), idle RDS instances, over-provisioned K8s requests, unused EBS snapshots.
- Savings Plans / Reserved Instances for steady load, Spot for stateless workers and CI.
- S3 lifecycle tiers, and gp3 instead of gp2 volumes.
- Tag everything with team, service, and environment for cost allocation.

---

## 8. Reliability architecture

- Multi-AZ for everything stateful (RDS Multi-AZ, ElastiCache with replicas, EKS nodes across AZs).
- Backups: automated RDS snapshots plus PITR. **Test restores** (an untested backup isn't a backup). Define RPO and RTO.
- Multi-region only when the business requires it (cost and complexity): Aurora Global Database, DynamoDB Global Tables, Route 53 failover.

---

## Interview Q&A

**Q: Lambda connecting to Postgres has issues at scale. Why, and how do you fix it?**
Each concurrent Lambda environment opens its own connection, so a traffic spike exhausts `max_connections`. Fix it with RDS Proxy (pooling and multiplexing), reserved concurrency to cap fan-out, connection reuse across warm invocations by creating the client outside the handler, or switching the workload to a queue with controlled concurrency.

**Q: How do users upload large files?**
The backend authorizes the request and issues a presigned S3 PUT URL (or presigned POST with size and content-type conditions). The browser uploads directly to S3 (multipart for big files). An S3 event to SQS triggers async processing (virus scan, parsing). Bytes never pass through the API servers.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`handler`](../../packages/backend/apps/lambdas/src/handlers/media-processing.ts#L48): The media-processing handler processes SQS batches idempotently against PostgreSQL. _(media-processing.ts)_
<!-- theory-links:end -->
