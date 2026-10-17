# Implementation Plan: S55 — Lambda workers (domain `infrastructure`)

**Branch**: `S55-serverless-workers` | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), constitution v3.1.0, and the two follow-ups left by S04 (below).

## Summary

Move the Lambda toolkit out of `apps/lambdas/src/shared` into a new library `libs/infrastructure/serverless` (batch helper, idempotency, Nest context cache, telemetry, manifest, runner engine) and make each part behave as `spec.md` says: per-record failure reporting with concurrent FIFO groups and a deadline margin; owner-token idempotency records with fingerprint, limits and an injectable clock; a manifest that is the single source for queue numbers and is checked against `elasticmq.conf` and Terraform; dead-letter handlers and a local `--redrive`; a local runner that starts functions from the built bundles; bundle checks; per-function IAM roles and alarms in `infra/modules/lambda_sqs_worker`. `apps/lambdas` keeps one wiring file per function; `apps/lambda-local` becomes a launcher. The living page `docs/spec/capabilities/S55-serverless-workers.md` does not exist yet and is written first (cross-spec rule 0).

## S04 follow-ups (requirements)

- **F-1 Dead-letter handler for `onboarding-documents`** (max receives 5, visibility at least 270 s; the queue has 720 s). `apps/lambdas/src/handlers/document-extractor-dlq.ts` and the manifest entry `document-extractor-dlq` (queue `onboarding-documents-dlq`, `batchSize` 5, `maxConcurrency` 5) already exist, but hand-wired around `processBatch`, outside any `deadLetter` field, with no idempotency record and no `DeadLetterHandlerFailed`. Plan: keep S04's reason `extraction_unavailable` (research D-4), express it as the `deadLetter` of the `document-extractor` entry (emitted to `manifest.json` as function `document-extractor-dlq`), put it on `defineSqsHandler` with an idempotency record per `documentId` (AS-34, AS-35).
- **F-2 Terraform event-source mapping for the DLQ.** `module "lambdas"` gets `queue_arns = module.sqs.queue_arns`, which holds only source queues, so the DLQ function has no queue ARN to map. Plan: the SQS module exports `dlq_arns`; the Lambda module takes them, resolves a dead-letter function's queue from them, creates the mapping with batch 5 and maximum concurrency 5 from `manifest.json`, and gives that function's role receive rights on its DLQ only (AS-37, checked by `manifest/terraform-conformance.spec.ts`).

## Technical Context

**Language/Version**: TypeScript (strict), Node 22 (Lambda `nodejs22.x`, arm64), NestJS 11 for context-based handlers; Terraform for the stack.

**Primary Dependencies**: `@aws-sdk/client-sqs` and `client-dynamodb` (external in bundles), zod, esbuild + tsc two-stage build, `fast-check`, OpenTelemetry API, S53 `TaskMessage` / `PermanentError` / `TransientError`, S54 clock and logger field names.

**Storage**: DynamoDB table `Idempotency` (`packages/backend/dynamodb/Idempotency.json`, TTL `expiresAtEpoch`); SQS / ElasticMQ queues. No Postgres table is owned or created.

**Testing**: Jest. Library e2e against DynamoDB local, ElasticMQ, Postgres (`docker-compose.test.yaml`) through `scripts/sdd/test-spec.sh`; unit specs beside the code; static conformance specs read `elasticmq.conf` and Terraform. Rows per scenario: [test-plan.md](test-plan.md).

**Target Platform**: AWS Lambda fed by SQS event source mappings; local runner on Linux/macOS.

**Project Type**: backend library plus two thin apps and infrastructure code.

**Performance Goals**: batches of 10, standard concurrency default 10, deadline margin 5 s, runner backoff 1 s to 30 s, metrics as log lines (no API call).

**Constraints**: visibility at least 6 × timeout; FIFO `maxConcurrency` at least 2; `Σ maxConcurrency × dbPoolMax ≤ 1000` (today 640, 650 with the DLQ function's 5 × 2 counted); result at most 64 KiB; key at most 512 characters; at most 3 metric dimensions.

**Scale/Scope**: 4 functions (3 plus the DLQ handler); a new function is one manifest entry plus one entry file (SC-008).

## Constitution Check

*GATE: pass before Phase 0; re-checked after Phase 1.*

| Rule | Status | Note |
|---|---|---|
| I Layered modules | pass | The toolkit holds no domain code; functions reach domains through exported modules or factories. |
| III Transactions (S54 rule 4) | pass | No new `sequelize.transaction`. None of the touched files has a `// S54 T037 audit` comment (only `projections/transactional-pipeline.ts` does, untouched). |
| IV Communication | pass | IX.7 R1 in-process: S04 `OnboardingExtractionModule`, S43 `WebhooksLambdaModule`, S29 `createMediaProcessor`. |
| VII Testing | pass | Every AS has a row; every degradation path is forced; fake clock, no sleeps. |
| VIII Operational safety | pass | Bodies and attribute values are never logged; metric calls never fail a record. |
| IX Isolation | pass | No cross-domain table access; G-07 command is re-run as a task. |
| X Structure | fixed by this plan | G-01, G-02, G-03: apps import libs, libs import no apps. |

No violation needs justification. **Post-design re-check**: still passing; the one choice touching another capability (error classes, D-3) goes through a sibling follow-up, not an edit of their spec.

## Lessons applied

- L-018 / L-015 / L-004: each function ships as a standalone bundle; `workers-wiring.e2e-spec.ts` invokes the built bundles; the launcher boots from `manifest.json`. The real standalone boots run at the final checkpoint and are not tasks (L-019).
- L-001: manifest validation checks FIFO flag against the `.fifo` suffix and rejects FIFO-only options on standard queues before anything is sent.
- L-002 / L-020: no new queue; `onboarding-documents-dlq` exists. The conformance spec fails when a manifest queue is missing from the queue file; the runner refuses to start while a consumed queue is missing (AS-42). Corrected visibility values in `elasticmq.conf` need an ElasticMQ reload (command in quickstart).
- L-003: every negative test asserts a specific error class or state.
- L-013: the broker-outage test (AS-45) restores the broker in `afterAll`.
- L-017: scenarios move with the old specs (`sqs-batch.spec.ts` → AS-01/03; `idempotency.e2e-spec.ts` → AS-14/15/16/17).
- L-016: `--redrive` of an empty queue exits 0 (AS-36).

## Project Structure

### Documentation (this feature)

```text
specs/domains/S55-serverless-workers/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/   manifest.md  idempotency-store.md  runner-cli.md  telemetry.md
└── tasks.md     # /speckit-tasks
```

### Source Code (repository root)

```text
packages/backend/
├── libs/infrastructure/serverless/        # NEW, index.ts is the public entry (X.4)
│   ├── batch/        sqs-batch.ts, define-sqs-handler.ts, sqs-types.ts
│   ├── idempotency/  idempotency.ts, idempotency-key.ts, idempotency-errors.ts, idempotency-options.ts
│   ├── context/      nest-context.ts
│   ├── telemetry/    telemetry.ts (log, metric, trace continuation)
│   ├── manifest/     lambda-spec.ts, lambdas.manifest.ts, validate-manifest.ts, queue-config-reader.ts
│   ├── runner/       runner.ts (startRunner), sqs-source.ts, event-builder.ts, redrive.ts
│   ├── bundling/     bundle-checks.ts
│   ├── testing/      fixture functions, fake clock, log and metric capture
│   └── workers-wiring.e2e-spec.ts
├── apps/lambdas/src/handlers/   webhook-delivery.ts, media-processing.ts, document-extractor.ts, document-extractor-dlq.ts (wiring only)
├── apps/lambda-local/src/main.ts   launcher: parse CLI, call startRunner / redrive
├── dynamodb/Idempotency.json       _design block gains ownerToken, fingerprint, resultOmitted, completedAt
└── scripts/build-lambdas.mjs       manifest from the lib, bundle checks, validated manifest.json
infra/
├── docker/elasticmq/elasticmq.conf     webhook-deliveries.fifo 180 s, media-processing 360 s
├── modules/lambda_sqs_worker/main.tf   per-function role, DLQ mapping, alarms
├── modules/sqs/main.tf                 export dlq_arns
└── stack/main.tf                       pass dlq_arns; idempotency table access per function
docs/spec/capabilities/S55-serverless-workers.md   NEW living page, first task
docs/showcase/sections/SD-03-serverless-lambdas.md notes update (G-56)
```

**Structure Decision**: toolkit in one infrastructure lib (X.1, X.3). Deleted: `apps/lambdas/src/shared/*`, `apps/lambdas/src/lambdas.manifest.ts`, `apps/lambdas/src/handlers/index.ts`.

## Work breakdown by gap

| Gaps | Plan area |
|---|---|
| G-01, G-02, G-03, G-46, G-54 | Create lib, move code, delete registry, export `startRunner`, `package.json` scripts |
| G-04, G-05, G-06, G-13, G-17, G-26, G-28 | Entry files on `defineSqsHandler` (research D-5 for missing sibling exports) |
| G-07 | Run `pnpm --dir packages/backend check:table-ownership --strict`, record the `apps/lambdas` lines; if it cannot run, write the blocker in questions.md |
| G-10 to G-16 | Rewrite `processBatch` and record type |
| G-18, F-1 | Dead-letter handler as manifest `deadLetter`; `--redrive` |
| G-20 to G-27 | Idempotency rewrite and store schema |
| G-30 to G-32, F-2 | Manifest fields, validation, conformance specs, queue file fixes |
| G-33 to G-35 | Terraform roles, alarms, DLQ mapping, redrive-allow assertion |
| G-36, G-50 to G-52 | `dbPoolMax`, context cache identity fix, telemetry validation, trace continuation |
| G-40 to G-45, G-47, G-48 | Runner behaviour |
| G-53 | Bundle checks |
| G-55, G-56 | Tests per test-plan; SD-03 notes; pattern-map rows P0107, P0604, P0706, P0809 stay `implemented` only when green |

Debt rows D-8 and D-14 are paid by G-04, G-05, G-06 (see gaps.md section B).

## Complexity Tracking

None.
