# SD-03 — Serverless Workers (SQS + Lambda)

Status: ☑ done (S55: specs run against the test stack; platform parity and the pager alarm are listed in specs/UNVERIFIED.md) · Phase 6 · Depends on: F-02 (SQS, S3, Dynamo) · Used by: SD-10, 26, 27, 30, 44 · DOUBTS Q6

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
| Local runner: `apps/lambda-local` polls ElasticMQ and invokes the built bundles with real SQS event shapes (D19) | — |

## Steps
- [x] `libs/infrastructure/serverless` — batch helper, idempotency (Dynamo), cached Nest context, telemetry, manifest, local runner; `apps/lambdas/src/handlers/*.ts` — wiring only.
- [x] `apps/lambda-local/` — launcher for the runner engine: long polling, no visibility extension (Lambda does not extend it), redrive.
- [x] esbuild script `scripts/build-lambdas.mjs` (one bundle per function, checked).
- [x] Terraform module `lambda_sqs_worker` (O-03).

## Scale
- Target: 0 → 1,000 concurrent executions in a minute; account concurrency reserved per function.
- First bottleneck: downstream DB connections → RDS Proxy + reserved concurrency; S3 prefix throughput → randomised key prefixes.

## Implementation notes (S55, 2026-10-17)
- **`libs/infrastructure/serverless`** (public entry `index.ts`; the Nest context cache is `serverless/context` and the runner `serverless/runner`, so a plain handler's bundle holds neither):
  - `batch/sqs-batch.ts` `processBatch`: partial batch failures. Standard queues run records concurrently up to a limit; on FIFO queues the groups run side by side, a group one record at a time, and a failure fails the rest of its group without running it. Records are not started inside the deadline margin (5 s, capped to half the budget).
  - `batch/define-sqs-handler.ts` `defineSqsHandler`: JSON and schema validation before domain code, the task message of S53, `DeadLettered` / `FifoGroupOrderBroken` on the last receive, safe failure logs (no body), trace continuation from the `traceparent` attribute.
  - `idempotency/`: DynamoDB `Idempotency` records with an owner token per attempt (completion and release are conditional on it, a late finisher gets `StaleClaimError`), lease, fingerprint, 64 KiB result limit, retention that counts as absent even before the lazy TTL deletion, and an injectable clock. A failed completion write keeps the claim.
  - `manifest/`: `LAMBDAS` is the single source for queue, FIFO flag, visibility, receive limit, timeout, memory, batch size, concurrency and `dbPoolMax`; a `deadLetter` entry expands to a function `<name>-dlq`. `validateManifest` runs in the build, the runner and CI; `queue-config-conformance.spec.ts` compares it with `elasticmq.conf` and `infra/stack/main.tf`.
  - `context/nest-context.ts`: Nest application context cached per container (a failed init is not cached; the manifest's `dbPoolMax` sets the pool).
  - `telemetry/`: JSON logs and CloudWatch EMF metrics (metrics are log lines; invalid calls are dropped with a warning), injectable clock.
- **Handlers** (`apps/lambdas/src/handlers`, wiring only): `webhook-delivery.ts` and `document-extractor.ts` use Nest through a hosting module; `media-processing.ts` is small and Nest-free; `document-extractor-dlq.ts` is the dead-letter handler of `onboarding-documents` (routes the document to review once, keeps the message when routing fails).
- **`apps/lambda-local`** is a launcher around `startRunner` (`pnpm start:lambda-local [name]`, builds the bundles first) and `--redrive <dlq>`. The runner starts functions from `dist/lambda-bundles/manifest.json` and the built bundles, uses the queue's own visibility timeout (no override, no heartbeat), honours batch size and concurrency, passes the full record with message attributes, and backs off 1 s to 30 s when the queue service is unreachable.
- **`scripts/build-lambdas.mjs`** (`pnpm build:lambdas`): validates the manifest, plain `tsc` first (esbuild cannot emit decorator metadata, which Nest DI needs), then esbuild per function (CJS, minified, `sharp`, `pg-hstore` and the AWS SDK external, native addons stubbed), checks every bundle (one copy of DI core and metadata polyfill, no inlined SDK, no top-level `await`, `handler` is a function, size) and writes the validated `manifest.json` for Terraform and the runner.
- **Terraform** `infra/modules/lambda_sqs_worker`: one role per function limited to its own queue (a dead-letter handler: its dead-letter queue), DLQ-depth, queue-age, throttle and error alarms, and the dead-letter event-source mapping (batch 5, concurrency 5).

## Test plan
See `specs/domains/S55-serverless-workers/test-plan.md` (52 scenarios): unit specs beside the code, library end-to-end specs against DynamoDB Local, ElasticMQ and Postgres, and `workers-wiring.e2e-spec.ts` for the built bundles.
