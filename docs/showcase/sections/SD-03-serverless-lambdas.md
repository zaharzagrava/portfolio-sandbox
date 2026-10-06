# SD-03 — Serverless Workers (SQS + Lambda)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: F-02 (SQS, S3, Dynamo) · Used by: SD-10, 26, 27, 30, 44 · DOUBTS Q6

## Marketplace adaptation
Spiky, bursty background work (thumbnails after a mass upload, webhook bursts, document parsing) runs as Lambdas fed by SQS — scale to zero at night, thousands in parallel during a sale.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Handlers: **plain small handlers** (thumbnail) vs **cached Nest standalone context** (`NestFactory.createApplicationContext` created outside handler, reused across warm invocations) | 10/04 #3 |
| Cold-start hygiene: esbuild bundle per handler, tree-shaken AWS SDK v3 clients, lazy imports | 10/04 #3, 08/03 |
| SQS event source: **partial batch failure** (`batchItemFailures`), visibility timeout ≥ 6× function timeout, DLQ + redrive, max concurrency on the ESM | 06/01 §3 |
| **Idempotency** via DynamoDB records (Powertools-style: `IN_PROGRESS` → `COMPLETED`, conditional writes, TTL) | 10/04 #3, D24 |
| DB access from Lambda: via **RDS Proxy** (Terraform) / reserved concurrency to cap connections | 10/04 #3 |
| Structured logs + EMF metrics + X-Ray/OTel | 10/04 #3 |
| Local runner: `apps/lambda-local` polls ElasticMQ and invokes handlers with real SQS event shapes (D19) | — |

## Steps
- [x] `apps/lambdas/src/` — `handlers/*.ts`, `shared/idempotency.ts` (Dynamo), `shared/nest-context.ts` (cached app), `shared/sqs-batch.ts` (partial failure helper — unit-tested, shared).
- [x] `apps/lambda-local/` — poller mapping queue → handler, long polling, visibility extension.
- [x] esbuild script `scripts/build-lambdas.mjs` (one zip per handler).
- [x] Terraform module `lambda_sqs_worker` (O-03).

## Scale
- Target: 0 → 1,000 concurrent executions in a minute; account concurrency reserved per function.
- First bottleneck: downstream DB connections → RDS Proxy + reserved concurrency; S3 prefix throughput → randomised key prefixes.

## Implementation notes (2026-10-02)
- **`apps/lambdas/src/shared`:**
  - `sqs-batch.ts` `processBatch`: partial batch failures. On standard queues, bounded concurrency. On FIFO queues, a failure fails the rest of that message group in the batch without running it (order kept).
  - `idempotency.ts`: Powertools-style records in DynamoDB `Idempotency` (`dynamodb/Idempotency.json`): conditional claim, IN_PROGRESS expiry for crashed attempts, COMPLETED replays the stored result, failure releases the claim.
  - `nest-context.ts`: Nest application context cached per container (failed init not cached).
  - `telemetry.ts`: JSON logs + CloudWatch EMF metrics (metrics as log lines, no API calls).
- **Two handler styles:**
  - `handlers/webhook-delivery.ts` uses Nest, since it needs the domain services (moved here from SD-30).
  - `handlers/media-processing.ts` is small and Nest-free (sharp + pg + S3 SDK at module scope, pool max 2 per container).
- **`lambdas.manifest.ts`** is the single source for queue, timeout, memory, batch size and max concurrency, shared by the runner, the bundler and Terraform (O-03).
- **`apps/lambda-local`** (`pnpm start:lambda-local [name]`): long-polls ElasticMQ, builds real SQS→Lambda events, deletes only the non-failed records, extends visibility while running, enforces the timeout.
- **`scripts/build-lambdas.mjs`** (`pnpm build:lambdas`): plain `tsc` first (esbuild cannot emit decorator metadata, which Nest DI needs), then esbuild bundles per handler, minified, with the AWS SDK external (shipped by the runtime), keepNames on, `@app/common` aliased. It also emits `manifest.json` for Terraform.

## Test plan
| Scenario | API e2e | UI journey | Unit |
|---|---|---|---|
| Only failed records are retried (standard) | — | — | `shared/sqs-batch.spec.ts` |
| FIFO group order kept after a failure | — | — | `shared/sqs-batch.spec.ts` |
| Duplicate delivery replays, concurrent delivery blocked, failure releases, crashed claim expires | `shared/idempotency.e2e-spec.ts` (DynamoDB Local) | — | — |
| Handlers end to end | covered by SD-10 / SD-30 specs (same cores) | — | — |
