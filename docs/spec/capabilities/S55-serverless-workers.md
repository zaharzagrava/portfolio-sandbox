---
id: S55
title: Lambda workers: partial batch failure, idempotent effects, manifest, dead letters, local runner, bundles
kind: capability
status: draft
generated_at: 77b7eaa3
depends_on: [S53, S54]
concepts: [idempotency-key, request-context, problem-json-errors]
models: []
scope:
  - packages/backend/libs/infrastructure/serverless/**
  - packages/backend/apps/lambdas/src/**
  - packages/backend/apps/lambda-local/src/**
  - infra/modules/lambda_sqs_worker/**
---
# S55 - Lambda workers: partial batch failure, idempotent effects, manifest, dead letters, local runner, bundles

## Purpose
Queue-driven work (webhook delivery, photo processing, KYC extraction) runs as functions fed by SQS. The toolkit in `libs/infrastructure/serverless` makes a bad record cost only itself, makes an effect happen once although delivery is at least once, keeps queue numbers in one manifest checked against the queue file and Terraform, parks poison messages in dead-letter queues with handlers and a redrive, and gives developers a local runner that behaves like the platform and starts the built bundles.

## Entry points
- `processBatch(event, handle, options)`: runs a batch and returns only the failed message IDs. [code: packages/backend/libs/infrastructure/serverless/batch/sqs-batch.ts#processBatch]
- `defineSqsHandler(options)`: wraps a record handler with body validation, task message mapping, dead-letter signals and logging. [code: packages/backend/libs/infrastructure/serverless/batch/define-sqs-handler.ts#defineSqsHandler]
- `Idempotency.run(key, work, options)` and `idempotencyKey(...parts)`. [code: packages/backend/libs/infrastructure/serverless/idempotency/idempotency.ts#Idempotency]
- `validateManifest(specs)` over `LAMBDAS`. [code: packages/backend/libs/infrastructure/serverless/manifest/validate-manifest.ts#validateManifest]
- `startRunner(options)` and `redrive(options)`: the local stand-in for the Lambda service. [code: packages/backend/libs/infrastructure/serverless/runner/runner.ts#startRunner]
- `nestContext(module)`: one Nest application context per container. [code: packages/backend/libs/infrastructure/serverless/context/nest-context.ts#nestContext]
- `log` and `metric`. [code: packages/backend/libs/infrastructure/serverless/telemetry/telemetry.ts#metric]

## Rules
- **S55.R-01** A batch response MUST list only the IDs of failed records, each once, in input order; a standard queue runs records concurrently up to a limit, and a thrown value of any kind fails only its own record. [proof: S55 AS-01, S55 AS-02, S55 AS-05, S55 AS-07, S55 AS-09]
- **S55.R-02** On a FIFO queue a group runs one record at a time and groups run independently; after a failure the later records of that group are reported failed without running. [proof: S55 AS-03, S55 AS-04]
- **S55.R-03** The batch helper MUST stop starting records when the remaining time falls below the deadline margin and report the unstarted records failed. [proof: S55 AS-08]
- **S55.R-04** A body that is not valid JSON or fails the declared schema MUST NOT reach the business handler; it is reported failed as a permanent failure, with no effect and no body in the log. [proof: S55 AS-06, S55 AS-11]
- **S55.R-05** A failure on the last allowed receive MUST emit `DeadLettered`, and on a FIFO queue also `FifoGroupOrderBroken`. [proof: S55 AS-10]
- **S55.R-06** A context that cannot initialise MUST fail the invocation as a whole. [proof: S55 AS-12]
- **S55.R-07** A claim is one conditional write; a live `COMPLETED` record replays its result without running the work, a live `IN_PROGRESS` record fails with `AlreadyInProgressError`, and an expired lease or expired retention counts as absent. [proof: S55 AS-13, S55 AS-14, S55 AS-15, S55 AS-18] [code: packages/backend/libs/infrastructure/serverless/idempotency/idempotency.ts#Idempotency]
- **S55.R-08** Completion and release MUST be conditional on the owner token; a holder whose lease was taken over fails with `StaleClaimError` and changes nothing. [proof: S55 AS-16, S55 AS-17] [code: packages/backend/libs/infrastructure/serverless/idempotency/idempotency-errors.ts#StaleClaimError]
- **S55.R-09** A fingerprint that differs from the record's fails with `IdempotencyKeyConflictError` and changes nothing. [proof: S55 AS-19]
- **S55.R-10** Keys are tenant-qualified, 1 to 512 characters, with no control characters and no empty part; a bad key, a non-positive lease or a lease below the function timeout is rejected before any store call. [proof: S55 AS-20, S55 AS-21, S55 AS-25] [code: packages/backend/libs/infrastructure/serverless/idempotency/idempotency-key.ts#idempotencyKey]
- **S55.R-11** A result over 64 KiB is not stored; the record completes with `resultOmitted`. [proof: S55 AS-22]
- **S55.R-12** When only the completion write fails, the claim stays and `IdempotencyCompletionFailed` is emitted; when the claim write fails, the work does not run and the error is transient. [proof: S55 AS-23, S55 AS-24]
- **S55.R-13** A message delivered twice, or two messages with one business key, produce one effect. [proof: S55 AS-26, S55 AS-27]
- **S55.R-14** The manifest is validated in the build, the runner and CI: visibility at least 6 times the timeout, FIFO flag equals the queue suffix, FIFO options never on a standard queue, FIFO concurrency at least 2, and the connection budget is not exceeded. [proof: S55 AS-28, S55 AS-30] [code: packages/backend/libs/infrastructure/serverless/manifest/validate-manifest.ts#validateManifest]
- **S55.R-15** Queue numbers in the manifest equal `elasticmq.conf` and the `queues` map of `infra/stack/main.tf`. [proof: S55 AS-29]
- **S55.R-16** Terraform gives each function failure reporting, its own role, alarms, retention, a redrive allow policy and the dead-letter event-source mapping. [proof: S55 AS-37]
- **S55.R-17** A FIFO message that fails blocks only its group until its receive limit; a standard message that reaches the limit lands in the DLQ with body, group and attributes. [proof: S55 AS-31, S55 AS-32, S55 AS-33]
- **S55.R-18** The `document-extractor` dead-letter handler routes the document to review once per document, and a failure keeps the message. [proof: S55 AS-34, S55 AS-35]
- **S55.R-19** Local redrive moves every message back with body, group and attributes, a fresh dedupe ID for FIFO, prints the count, and an empty queue exits 0. [proof: S55 AS-36]
- **S55.R-20** The runner gives the full record shape, uses the queue's own visibility, honours concurrency and batch size, deletes exactly the successes, survives delete and receive failures with backoff, stops gracefully, and refuses to start on a bad manifest, queue or bundle. [proof: S55 AS-38, S55 AS-39, S55 AS-40, S55 AS-41, S55 AS-42, S55 AS-43, S55 AS-44, S55 AS-45]
- **S55.R-21** The trace context of the producer continues in the function and its log lines. [proof: S55 AS-50]
- **S55.R-22** A failed context initialisation is not cached; another module is unaffected, and a warm context initialises once. [proof: S55 AS-46, S55 AS-47]
- **S55.R-23** Each function is built as one CJS bundle with a function `handler`, no top-level `await`, a single copy of shared libraries and no inlined AWS SDK; `manifest.json` equals the manifest. [proof: S55 AS-48, S55 AS-49, S55 AS-52]
- **S55.R-24** An invalid metric call (more than 3 dimensions, non-finite value, unknown unit) is dropped with a warning and never throws. [proof: S55 AS-51] [code: packages/backend/libs/infrastructure/serverless/telemetry/telemetry.ts#metric]

## Behaviors
- **S55.B-01** Given a standard batch `a`, `b`, `c` where `b` throws, when processed, then the response lists only `b` and each record ran once. [proof: S55 AS-01]
- **S55.B-02** Given a FIFO batch `a1`, `a2`, `b1`, `a3` where `a2` throws, when processed, then `a2` and `a3` are reported and `b1` ran. [proof: S55 AS-03]
- **S55.B-03** Given the same message twice, when the function runs both, then one effect row exists and the record is `COMPLETED`. [proof: S55 AS-26]
- **S55.B-04** Given a poison message `a1` in group A of a FIFO queue, when it fails, then `b1` is processed at once and `a2` waits until `a1` is dead-lettered. [proof: S55 AS-32]
- **S55.B-05** Given three messages in a dead-letter queue, when redrive runs, then three return to the source queue and the count 3 is printed. [proof: S55 AS-36]

## Lifecycles
- Idempotency record: none, then `IN_PROGRESS` (conditional claim), then `COMPLETED` (token match); `IN_PROGRESS` is deleted on a failed work (token match); an expired lease or retention is replaced by a new claim. [proof: S55 AS-13, S55 AS-17]

## Owns
- Tables: the DynamoDB table `Idempotency` (no Postgres table).
- Metrics: namespace `Marketplace/Lambda`: `RecordsProcessed`, `RecordsFailed`, `InvocationMs`, `DeadLettered`, `FifoGroupOrderBroken`, `IdempotencyReplay`, `IdempotencyCompletionFailed`, `DeadLetterHandlerFailed`.
- Configuration: deadline margin (5 s), result limit (64 KiB), key limit (512), retention (24 h), connection budget (1,000), runner backoff (1 s to 30 s), `LAMBDA_LOCAL_MAX_CONCURRENCY`.
- Code: `packages/backend/libs/infrastructure/serverless/`, `packages/backend/scripts/build-lambdas.mjs`, `infra/modules/lambda_sqs_worker/`.

## Decisions
- The manifest is the single source of queue numbers; the queue file and Terraform are checked against it.
- Delivery is at least once, so effects are guarded by owner-token records instead of by trusting the queue.
- The local runner starts the built bundles, so what runs locally is what is deployed.

## Known gaps
- Pager delivery of the dead-letter alarm, platform-versus-local parity of the event, and the `terraform plan` of a new function need a deployed stack (SC-003, SC-007, SC-008); they are listed in `specs/UNVERIFIED.md`.
