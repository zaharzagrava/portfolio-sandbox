# Tasks: S55 — Lambda workers (domain `infrastructure`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `contracts/`, `research.md`, `quickstart.md`.

**Tests**: Requested (test-plan.md, constitution VII). Each scenario's failing test task comes before its code task.

**Conventions**: `LIB` = `packages/backend/libs/infrastructure/serverless`. Run backend commands from `packages/backend`; e2e specs through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>`. No new `sequelize.transaction`. Never touch `*.reviewed.json`. Runtime proofs (standalone boots, fresh-stack run, browser or journey suite) are NOT tasks: they are done at the final checkpoint (L-019).

## Phase 1: Setup

- [X] T001 Write the living page `docs/spec/capabilities/S55-serverless-workers.md` first (rules and behaviours from spec.md FR-001..FR-078, `[proof: ...]` pointing at the test files of test-plan.md, `[code: ...]` at `LIB`); run `python3 scripts/livespec/check.py` and fix until it passes (cross-spec rule 0).
- [X] T002 Create the library skeleton `LIB` (`index.ts` as public entry, folders `batch/ idempotency/ context/ telemetry/ manifest/ runner/ bundling/ testing/`) and register the path alias (`@app/infrastructure/serverless` or the repo's existing alias form) in `packages/backend/tsconfig*.json` and jest `moduleNameMapper`. (The existing `@app/infrastructure/*` alias covers it; nothing to register.)
- [X] T003 [P] Create test helpers in `LIB/testing/`: fake clock (injectable `now()`), log and metric capture from the output stream, `waitFor`, fixture functions with an effect-row counter (used by AS-26/27, AS-46).
- [X] T004 [P] Add the `_design` fields `ownerToken`, `fingerprint`, `resultOmitted`, `completedAt` to `packages/backend/dynamodb/Idempotency.json` (G-27).

## Phase 2: Foundational (blocks all stories)

- [X] T005 Move `apps/lambdas/src/shared/{sqs-batch,idempotency,nest-context,telemetry}.ts` and `apps/lambdas/src/lambdas.manifest.ts` into `LIB/{batch,idempotency,context,telemetry,manifest}/` with their specs (`sqs-batch.spec.ts`, `idempotency.e2e-spec.ts` keep their scenarios: L-017); re-export from `LIB/index.ts`; update importers (G-02).
- [X] T006 Delete `apps/lambdas/src/handlers/index.ts` `HANDLERS` registry; the manifest becomes the only registry (G-03, FR-073).
- [X] T007 Extend `SqsRecord` in `LIB/batch/sqs-types.ts` with `messageAttributes`, `eventSource`, `awsRegion`, `md5OfBody`, `MessageDeduplicationId`, `SequenceNumber` (G-16).
- [X] T008 Run `pnpm --dir packages/backend check:table-ownership --strict` and record the `apps/lambdas` lines under G-07 in gaps.md; if it cannot run, write the blocker in questions.md (G-07). (Ran: 0 accesses; recorded under gaps.md section I.)
- [X] T009 Confirm S53 `PermanentError` / `TransientError` are importable from a library `serverless` may use without importing a domain; if not, add a bullet under `## Sibling-spec follow-ups` in gaps.md (`- **S53**: ...`) and use a local re-export (questions CONTRACT). (Importable from `@app/infrastructure/projections/errors`; `check:boundaries` accepts it; an S53 bullet records the path.)

## Phase 3: User Story 1 — A bad record does not redo the good ones (P1)

**Goal**: per-record failure reporting for standard and FIFO queues, bodies validated, deadline margin, dead-letter signals.
**Independent test**: `test-spec.sh libs/infrastructure/serverless/batch` green.

- [X] T010 [P] [US1] Write failing `LIB/batch/sqs-batch.spec.ts` for AS-01 (standard: only `b` reported, one call each), AS-02 (`it.each` all ok, all fail, empty), AS-03 (FIFO suffix failure).
- [X] T011 [P] [US1] Write failing tests in `LIB/batch/sqs-batch.spec.ts` for AS-04 (controllable promises: groups parallel, one group sequential), AS-05 (max in flight 2), AS-07 (`it.each` thrown values: non-Error, undefined, string), AS-08 (fake remaining time, deadline margin 5 s, standard and FIFO).
- [X] T012 [P] [US1] Write failing `LIB/batch/sqs-batch.property.spec.ts` for AS-09 with `fast-check` (invariants a, b, c over random batches).
- [X] T013 [P] [US1] Write failing `LIB/batch/define-sqs-handler.spec.ts` for AS-06 (`it.each` bad bodies: handler not called, failure class), AS-10 (receive count 4 vs 5, standard vs FIFO, `DeadLettered` / `FifoGroupOrderBroken` metric lines), AS-11 (log line fields; body and attributes absent), AS-12 (init rejects: invocation rejects, no record handler ran).
- [X] T014 [US1] Rewrite `processBatch` in `LIB/batch/sqs-batch.ts`: FIFO groups concurrent, each group sequential and stopping at first failure (later records of the group reported failed), `Set` for the response (G-12), concurrency cap, deadline margin from remaining time, log and metric for each failure with failure class, no swallowed `catch {}` (G-10, G-11, G-14).
- [X] T015 [US1] Implement `defineSqsHandler` in `LIB/batch/define-sqs-handler.ts`: `bodySchema` (zod) parse of JSON, `TaskMessage` mapping, receive-limit awareness from manifest `maxReceiveCount`, `DeadLettered` / `FifoGroupOrderBroken` metrics, log fields without body (G-13, G-15, AS-06, AS-10..12).
- [X] T016 [US1] Write failing `LIB/batch/define-sqs-handler.e2e-spec.ts` for AS-06: invalid JSON and schema failure through a real queue and the runner, no effect row, log has no body (depends on T031 runner; keep after the runner exists, then make it pass).
- [X] T017 [US1] Run `test-spec.sh libs/infrastructure/serverless/batch` until T010..T016 pass.

## Phase 4: User Story 2 — Exactly-once effects on at-least-once delivery (P1)

**Goal**: owner-token idempotency records with fingerprint, limits and injectable clock.
**Independent test**: `test-spec.sh libs/infrastructure/serverless/idempotency` green.

- [X] T018 [P] [US2] Write failing `LIB/idempotency/idempotency-key.spec.ts` for AS-20 (tenant-qualified keys differ) and AS-21 (`it.each` empty, 513 characters, control character, empty part; no store call).
- [X] T019 [P] [US2] Write failing `LIB/idempotency/idempotency-options.spec.ts` for AS-25 (`it.each` lease 0, negative, below function timeout).
- [X] T020 [US2] Write failing `LIB/idempotency/idempotency.e2e-spec.ts` (DynamoDB local, fake clock, `waitFor`, no real sleeps: G-24) for AS-13 (record read back mid-flight and completed), AS-14 (replay, work counter 1, record unchanged), AS-15 (`Promise.all` two deliveries, one record), AS-16 (failure releases only own token, retry runs), AS-17 (lease expires, B completes, A's completion and release rejected with `StaleClaimError`).
- [X] T021 [US2] Add to `LIB/idempotency/idempotency.e2e-spec.ts` failing tests for AS-18 (completed but past `expiresAtEpoch` runs again), AS-19 (fingerprint mismatch on `COMPLETED` and `IN_PROGRESS`, record unchanged, `IdempotencyKeyConflictError`), AS-20 (two functions, two tenants), AS-22 (64 KiB stored, 64 KiB + 1 gives `resultOmitted`, replay), AS-23 (completion write fails once at the store edge: claim stays, in-lease duplicate in progress, post-lease rerun, metric), AS-24 (store unreachable on claim: work not run, transient classification).
- [X] T022 [P] [US2] Create `LIB/idempotency/idempotency-errors.ts` (`StaleClaimError`, `IdempotencyKeyConflictError`, `IdempotencyInProgressError`) and `idempotency-options.ts` (validate lease positive and at least function timeout: AS-25, G-23). (The in-progress error keeps its existing name `AlreadyInProgressError`.)
- [X] T023 [P] [US2] Create `LIB/idempotency/idempotency-key.ts` `idempotencyKey(...parts)`: tenant-qualified, "key 1–512 characters, no control characters, no empty part" (data-model), validated before any store call (G-23, AS-20, AS-21).
- [X] T024 [US2] Rewrite `LIB/idempotency/idempotency.ts`: claim condition honours `expiresAtEpoch` (G-20); `ownerToken` random per attempt; completion and release conditional on token, `StaleClaimError` otherwise (G-21); separate try blocks so a failed completion write keeps the claim and emits a metric instead of releasing (G-22); fingerprint check (G-23); 64 KiB result limit with `resultOmitted` (G-23, G-25); malformed record without `status` is a live conflict (G-25); injectable clock replaces `Date.now()` (G-24); `completedAt` set.
- [X] T025 [US2] Add to `LIB/workers-wiring.e2e-spec.ts` failing tests with a fixture function for AS-26 (same message twice through the runner, one effect row, record `COMPLETED`) and AS-27 (two messages, same business key, one effect) (G-28).
- [X] T026 [US2] Run `test-spec.sh libs/infrastructure/serverless/idempotency` until green (AS-26/27 wait for T031).

## Phase 5: User Story 3 — FIFO groups, queue limits, dead letters, redrive (P2)

**Goal**: manifest as single source for queue numbers, conformance with queue file and Terraform, dead-letter handlers, redrive, S04 follow-ups F-1 and F-2.
**Independent test**: `test-spec.sh libs/infrastructure/serverless/manifest` and `.../runner/dead-letter`, `fifo-semantics` green.

- [X] T027 [P] [US3] Write failing `LIB/manifest/manifest.spec.ts` for AS-28 (`it.each` 179 s visibility fails, 180 s passes for 30 s timeout, dead-letter entry expanded) and AS-30 (`it.each` one rule violation per row: visibility ≥ 6 × timeout, FIFO `maxConcurrency` ≥ 2, FIFO flag vs `.fifo` suffix, FIFO-only options on standard queue (L-001), `Σ maxConcurrency × dbPoolMax ≤ 1000` incl. the DLQ function's 5 × 2).
- [X] T028 [P] [US3] Write failing `LIB/manifest/queue-config-conformance.spec.ts` for AS-29: parse `infra/docker/elasticmq/elasticmq.conf` and the `queues` map of `infra/stack/main.tf`; compare visibility, receive limit, FIFO flag, DLQ name with the manifest; failure message names file and field; fails when a manifest queue is missing from the queue file (L-002).
- [X] T029 [P] [US3] Write failing `LIB/manifest/terraform-conformance.spec.ts` for AS-37: in `infra/modules/lambda_sqs_worker` and `infra/modules/sqs` assert failure reporting (`ReportBatchItemFailures`), a role per function, receive rights on the function's own queue only, DLQ-depth / queue-age / throttles / errors alarms, retention, redrive allow policy, and the DLQ event-source mapping with batch 5 and maximum concurrency 5 (F-2, G-33, G-34, G-35).
- [X] T030 [US3] Implement `LIB/manifest/lambda-spec.ts` (`LambdaSpec` fields per data-model: `fifo`, `visibilityTimeoutSec`, `maxReceiveCount`, `dbPoolMax` default 2, `deadLetter?`), `validate-manifest.ts` and `queue-config-reader.ts`; implement `LIB/manifest/lambdas.manifest.ts` with the three functions plus `deadLetter` on `document-extractor` (reason `extraction_unavailable`, queue `onboarding-documents-dlq`, `batchSize` 5, `maxConcurrency` 5, emitted as function `document-extractor-dlq`) (G-30, F-1, contracts/manifest.md).
- [X] T031 [US3] Implement the runner engine in `LIB/runner/` (see Phase 6 tasks T041..T052); this task is the ordering anchor so US1/US2 e2e specs can run: create `runner.ts` exporting `startRunner(options)` returning `{ stop() }`, `sqs-source.ts`, `event-builder.ts` (G-46). (The SQS calls live in `runner.ts` and `redrive.ts`; there is no separate `sqs-source.ts`.)
- [X] T032 [P] [US3] Fix `infra/docker/elasticmq/elasticmq.conf`: `webhook-deliveries.fifo` visibility 180 s, `media-processing` 360 s, `onboarding-documents` 720 s with max receives 5 and `onboarding-documents-dlq` present (G-31, F-1); note the ElasticMQ reload command from quickstart in the task result (L-020). (Reload: `docker compose -p marketplace_test -f docker-compose.test.yaml restart test_elasticmq`; the DLQ also got 270 s.)
- [X] T033 [US3] Write failing `LIB/runner/fifo-semantics.e2e-spec.ts` for AS-31 (dedupe within window, order per group, one batch per group in flight, groups concurrent) and AS-32 (poison `a1` blocks `a2` only, `b1` immediate, `a1` to DLQ at receive 3, `a2` then processed, `DeadLettered` metric once).
- [X] T034 [US3] Write failing `LIB/runner/dead-letter.e2e-spec.ts` for AS-33 (standard queue, 3 receives, DLQ holds body, group, attributes) and AS-36 (`--redrive` of three messages including FIFO, fresh dedupe ID, count printed; empty queue moves 0 and exits 0: L-016).
- [X] T035 [US3] Implement `LIB/runner/redrive.ts` (`redrive(queue)` moves DLQ messages back, new dedupe ID for FIFO, prints count, exit 0 on empty) (G-35, FR-046).
- [X] T036 [US3] Write failing tests in `LIB/workers-wiring.e2e-spec.ts` for AS-34 (built bundle `document-extractor-dlq` with real Postgres: document ends in review state, queue empty) and AS-35 (`routeToReview` failure keeps the message, retried after visibility, metric emitted; duplicate after success routes once).
- [X] T037 [US3] Rewrite `apps/lambdas/src/handlers/document-extractor-dlq.ts` as wiring only on `defineSqsHandler`, importing only `@app/domains/seller-onboarding` (`OnboardingExtractionModule`), reason `extraction_unavailable`, idempotency record per `documentId`, `DeadLettered` / `DeadLetterHandlerFailed` metrics; wire it as the `deadLetter` of `document-extractor` (F-1, G-18, AS-34, AS-35).
- [X] T038 [US3] Terraform: `infra/modules/sqs/main.tf` exports `dlq_arns`; `infra/stack/main.tf` passes `dlq_arns` to `module "lambdas"` and per-function idempotency table access; `infra/modules/lambda_sqs_worker/main.tf` resolves a dead-letter function's queue from `dlq_arns`, creates the mapping with `batch_size` 5 and `maximum_concurrency` 5 read from `manifest.json`, one role per function with receive/delete on its own queue (DLQ only for the DLQ function), and alarms (errors, DLQ depth, queue age, throttles) (F-2, G-33, G-34, AS-37).
- [X] T039 [US3] Make `manifest.spec.ts`, `queue-config-conformance.spec.ts`, `terraform-conformance.spec.ts`, `fifo-semantics`, `dead-letter` and AS-34/35 pass; run `test-spec.sh libs/infrastructure/serverless/manifest` then `.../runner/fifo-semantics` and `.../runner/dead-letter`.

## Phase 6: User Story 4 — A local runner that behaves like the platform (P2)

**Goal**: runner started from built bundles, same record shape and retry semantics as Lambda.
**Independent test**: `test-spec.sh libs/infrastructure/serverless/runner` green.

- [X] T040 [US4] Write failing `LIB/runner/local-runner.e2e-spec.ts` for AS-38 (full record shape for standard and FIFO, attributes incl. `traceparent` round trip), AS-39 (failed record visible again with receive count 2, no visibility extension call), AS-40 (throwing and never-returning function: no deletes, redelivery, log lines incl. abandoned execution).
- [X] T041 [US4] Add to `local-runner.e2e-spec.ts` failing tests for AS-41 (20 messages, batch ≤ 5, ≤ 2 in flight, each once), AS-42 (four start-up failures: missing queue, unknown CLI name, unregistered handler, invalid manifest; non-zero exit, zero receive calls), AS-43 (termination signal mid-invocation: successes deleted, exit 0, no receive after stop), AS-44 (delete reports failed entries, logged, redelivered), AS-45 (queue service stopped and restarted; backoff 1 s to 30 s on the fake clock; resumes; restore the broker in `afterAll`: L-013), AS-50 (producer span → message → function span, same trace ID, parent id, log lines carry trace and message IDs).
- [X] T042 [US4] Implement `LIB/runner/runner.ts`: use the queue's own visibility timeout (drop the `timeoutSec * 6` override and the heartbeat: G-40); request `MessageAttributeNames: ['All']` and full record via `event-builder.ts` (G-41, AS-38); per-function concurrency up to `maxConcurrency` (G-42); timeout race that logs the abandoned execution (G-43); inspect delete result and log failed entries (G-44).
- [X] T043 [US4] Implement in `LIB/runner/runner.ts` start-up validation (missing queue, unknown name, missing handler → throw before any receive: G-47, AS-42, L-002), graceful stop that aborts the pending long poll and drains in-flight work (G-45, AS-43), pump errors surfaced and receive-failure exponential backoff 1 s to 30 s with injectable clock (G-45, G-48, AS-45).
- [X] T044 [US4] Implement trace continuation in `LIB/telemetry/telemetry.ts` and `defineSqsHandler`: read `traceparent` attribute, start the function span as child, put trace ID and message ID in log lines (G-52, AS-50). (`telemetry/trace.ts`.)
- [X] T045 [US4] Rewrite `apps/lambda-local/src/main.ts` as a launcher: parse CLI (`--functions`, `--redrive <queue>`), read `dist/lambda-bundles/manifest.json`, load bundles, call `startRunner` / `redrive`; no imports from `apps/lambdas` (G-01, FR-060).
- [X] T046 [US4] Update `packages/backend/package.json` scripts: `start:lambda-local` runs `pnpm build:lambdas` first then the launcher, `redrive` subcommand documented (G-54).
- [X] T047 [US4] Run `test-spec.sh libs/infrastructure/serverless/runner` until all runner specs pass.

## Phase 7: User Story 5 — Two handler styles, one bundle per function, observable (P3)

**Goal**: Nest context cache correct, one CJS bundle per function with checks, validated telemetry and manifest.json.
**Independent test**: `.../context`, `.../telemetry`, `.../bundling` green.

- [X] T048 [P] [US5] Write failing `LIB/context/nest-context.e2e-spec.ts` for AS-46 (counter provider, three invocations, one init) and AS-47 (first init fails, second succeeds, other module unaffected).
- [X] T049 [P] [US5] Write failing `LIB/telemetry/telemetry.spec.ts` for AS-51 (`it.each` valid line shape; 4 dimensions, `NaN`, unknown unit dropped with a warning; never throws).
- [X] T050 [US5] Write failing `LIB/bundling/build-lambdas.e2e-spec.ts` for AS-48 (build runs; one CJS bundle per entry; `handler` is a function; no top-level `await`; plain bundle has no Nest), AS-49 (source maps list one copy of DI core, metadata polyfill, validator; no AWS SDK; size limit), AS-52 (`manifest.json` equals the manifest by schema parse; runner starts from it).
- [X] T051 [US5] Fix `LIB/context/nest-context.ts`: on init failure delete the cache entry only if the stored promise is the same one (identity compare) (G-50, AS-46, AS-47).
- [X] T052 [US5] Rewrite `LIB/telemetry/telemetry.ts`: validate dimensions (at most 3), value finite, unit known (drop with a warning, never throw), trace ID field, clock injection, log field names `level`, `message`, `time`, `traceId` per S54, standard metrics of FR-078 (G-51, AS-51).
- [X] T053 [US5] Implement `LIB/bundling/bundle-checks.ts` (single DI core and metadata polyfill, no top-level `await`, handler export, no AWS SDK inlined, size limit) and update `packages/backend/scripts/build-lambdas.mjs`: manifest from the lib, dead-letter entries expanded, bundle checks, validated `manifest.json` (G-53, AS-48, AS-49, AS-52). Keep `format: 'cjs'` (P0107).
- [X] T054 [US5] Run `pnpm build:lambdas`, then `test-spec.sh libs/infrastructure/serverless/context`, `.../telemetry`, `.../bundling` until green.

## Phase 8: Function wiring (cross-story gaps)

- [X] T055 [P] Rewrite `apps/lambdas/src/handlers/webhook-delivery.ts` on `defineSqsHandler` with FIFO flag from manifest; import `WebhooksLambdaModule` and `WebhookDeliveryHandler` instead of `WebhooksCoreModule` / `WebhookDeliverer`; retry by throwing `TransientError` instead of `Error('redeliver')` (G-06, G-17, D-8). If S43 does not export them yet, follow research D-5 and add a bullet `- **S43**: ...` under `## Sibling-spec follow-ups` in gaps.md. (S43 exports only the host; wrapped; S43 bullet added.)
- [X] T056 [P] Rewrite `apps/lambdas/src/handlers/media-processing.ts` on `defineSqsHandler` with S29 `createMediaProcessor(deps)` and infrastructure adapters (no inline S3 client / `pg` pool / `Sql` import), events through `appendWithExecutor`; lease derived from the manifest timeout (not `120_000`); key built with `idempotencyKey(shop, originalKey)` (G-04, G-26, AS-20, D-8). Missing sibling export → research D-5 and a `- **S29**:` follow-up bullet. (On `defineSqsHandler`; adapters stay inline, S29 bullet added; the processor's own claim is its idempotency, so no second record.)
- [X] T057 [P] Rewrite `apps/lambdas/src/handlers/document-extractor.ts` on `defineSqsHandler`: drop `LlmUnavailableError` / `@app/domains/assistant` import and direct `ExtractionService`, classify with `TransientError` / `PermanentError`, import only `@app/domains/seller-onboarding` (`OnboardingExtractionModule`) (G-05, D-14). Missing S04 error classes → `- **S04**:` follow-up bullet.
- [X] T058 Add `dbPoolMax` per function to the manifest entries and apply it to the Nest database pool in `LIB/context/nest-context.ts` / handlers; confirm the connection budget sum is 650 (G-36, AS-30).
- [X] T059 Run `test-spec.sh libs/infrastructure/serverless/workers-wiring` (AS-26, AS-27, AS-34, AS-35) until green.

## Phase 9: Polish & cross-cutting

- [X] T060 [P] Update `docs/showcase/sections/SD-03-serverless-lambdas.md` implementation notes (remove the heartbeat sentence, describe the new library and runner) (G-56).
- [X] T061 [P] Update `docs/work/architecture/pattern-map.md` rows P0107, P0604, P0706, P0809 to `implemented` only for scenarios that are green (G-56). (All four rows already say `implemented` and every scenario is green; no edit needed.)
- [X] T062 [P] Add `## Spec changes` / `## Sibling-spec follow-ups` sections to `gaps.md` for anything collected in T009, T055..T057 (rule 1); confirm `## Spec changes` states "none signed by a human changed" if true.
- [X] T063 [P] Confirm `quickstart.md` "Ops artifacts" lists SC-003, SC-007, SC-008 and `specs/UNVERIFIED.md` has the three S55 rows with status `not run` (already present; edit only if criteria change).
- [X] T064 Static checks: `npx tsc --noEmit`, ESLint on `LIB`, `apps/lambdas`, `apps/lambda-local`; `pnpm check:boundaries` (no import from `apps/` in libs, infrastructure imports no domain); `python3 scripts/livespec/check.py`.
- [X] T065 Run the whole `libs/infrastructure/serverless` suite once with `test-spec.sh libs/infrastructure/serverless` (batches if a run lacks its summary line: L-008).

## Dependencies & order

- Phase 1 → Phase 2 → stories. T031 (runner anchor) must precede e2e that use the runner (T016, T025, T033, T034, T036); T042/T043 complete it.
- US1 and US2 are independent of each other after Phase 2. US3 needs the manifest (T030) and runner anchor (T031). US4 builds on T031. US5 is independent except T053 needing the manifest. Phase 8 needs US1, US2, US3 libs.
- Test tasks always precede the code tasks that satisfy them.

## Parallel examples

- After Phase 2: T010, T011, T012, T013 (US1 tests) together with T018, T019 (US2 tests) and T048, T049 (US5 tests).
- T027, T028, T029, T032 (US3) in parallel; T055, T056, T057 in parallel.

## Implementation strategy

MVP = Phase 1, 2 and US1 (T010..T017). Then US2 (the other P1), then US3/US4 (P2, incl. the S04 follow-ups F-1 and F-2), then US5, wiring and polish.

## Coverage

- AS-01..AS-52 each have a failing-test task (T010..T013, T016, T018..T021, T025, T027..T029, T033, T034, T036, T040, T041, T048..T050). gaps.md G-01..G-56 and follow-ups F-1, F-2 each map to a task (G-07 T008; G-56 T060/T061).
