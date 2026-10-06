# Gaps: S55 — Lambda workers (domain `infrastructure`)

The implementation agent's to-do list: what the current code gets wrong or lacks against [`spec.md`](spec.md). Paths are under `packages/backend/` unless stated. Line numbers are from the code at the time of writing.

## A. Boundaries (constitution X, IX; the IX.7 mechanism that replaces each violation)

- **G-01** `apps/lambda-local/src/main.ts:2-4` imports `../../lambdas/src/lambdas.manifest`, `handlers`, `shared/sqs-batch` → X.1 ("nothing imports from `apps/`"). Fix: the runner engine moves to `libs/infrastructure/serverless/runner`, the launcher starts functions from `dist/lambda-bundles/manifest.json` and the bundles (FR-060, AS-52). No IX.7 mechanism is needed: no data is crossed.
- **G-02** `apps/lambdas/src/shared/*` (batch, idempotency, nest-context, telemetry) and `lambdas.manifest.ts` are libraries living in an app → X.1, X.3. Move to `libs/infrastructure/serverless/{batch,idempotency,context,telemetry,manifest}`; tests move with them (`sqs-batch.spec.ts`, `idempotency.e2e-spec.ts`).
- **G-03** `apps/lambdas/src/handlers/index.ts:11-15` `HANDLERS` registry duplicates the manifest names and has no entry for dead-letter handlers → delete; manifest is the registry (FR-073).
- **G-04** `apps/lambdas/src/handlers/media-processing.ts:17-38` builds an S3 client, a `pg` pool, a transaction runner and object-store adapters inline, and imports `MediaProcessor` and `Sql` from the media barrel (line 5) → FR-074, D-8. Replace with S29's `createMediaProcessor(deps)` and adapters from infrastructure libs; the SQL stays in the media domain (no cross-domain SQL here). Events through `appendWithExecutor` (S53).
- **G-05** `apps/lambdas/src/handlers/document-extractor.ts:5` imports `LlmUnavailableError` from `@app/domains/assistant`, and line 93 uses `ExtractionService` from seller-onboarding directly → cross-domain import in a bootstrap file (D-14). Replace with S04's `TransientError` / `PermanentError` classification; the function imports only `@app/domains/seller-onboarding` (`OnboardingExtractionModule`). Mechanism: R1 (exported module in the same process).
- **G-06** `apps/lambdas/src/handlers/webhook-delivery.ts:90,106-109` imports `WebhooksCoreModule`, `WebhookDeliverer`, `WebhookDelivery` from the developer-platform barrel → D-8 (S43 stops exporting them). Replace with `WebhooksLambdaModule` and `WebhookDeliveryHandler` (R1).
- **G-07** Table ownership (`pnpm --dir packages/backend check:table-ownership`): the command could not be run in this session (the sandbox required approval for it). Static inspection found: no `InjectModel`, `forFeature`, `sequelize.query` or model import in `libs/infrastructure/sqs`, `libs/infrastructure/idempotency`, `libs/infrastructure/aws` or `apps/lambdas`; the only SQL in the capability's code is the raw `pool.query` calls in `media-processing.ts:20,25,26,29`, which pass a generic executor into the media domain (the SQL strings are media's own). **Re-run the command before closing this gap** and attach the lines for `apps/lambdas`; any line naming a table not owned by the function's domain is paid by R1 (exported service) or R3 (read model) in the owning capability (D-7, D-12 list), never by S55.

## B. Debt register rows (docs/architecture/debt-register.md)

No row names `S55`. Open rows that touch this capability's code:

- **D-8** (barrels export infrastructure internals because apps wire them): `webhook-delivery.ts` and `media-processing.ts` import `WebhookDeliverer`, `MediaProcessor`, `Sql` → paid by G-04 and G-06 (apps import the domain's Lambda module or factory).
- **D-14** (LLM provider port in `assistant/infra/llm`, used by the document-extractor Lambda) → paid by G-05; the port move itself is S46.
- **D-6** (layering in domains) — not touched here. **D-7, D-12** — no S55 lines (see G-07). **D-16** (elasticsearch lib), **D-17** (rate-limit file cycle), **D-11**, **D-15** — not this capability.
- Resolved rows D-1, D-2, D-3, D-4, D-5, D-9, D-13 are not reopened; `pnpm check:boundaries` must stay green.

## C. Partial batch failures (FR-001 to FR-011)

- **G-10** `apps/lambdas/src/shared/sqs-batch.ts:34-48` FIFO path runs the whole batch sequentially; groups do not run concurrently (FR-004, AS-04).
- **G-11** `sqs-batch.ts:44,56` `catch {}` swallows every error: no log, no metric, no failure class (FR-006, FR-010, AS-11).
- **G-12** `sqs-batch.ts:63` builds the response with `failures.includes` over the records (quadratic); use a `Set` (FR-001, AS-09 property).
- **G-13** No body parsing or schema validation anywhere: `webhook-delivery.ts:109`, `document-extractor.ts:95` call `JSON.parse` inside the handler, `media-processing.ts:43` casts (FR-005, AS-06). Introduce `defineSqsHandler` with `bodySchema`.
- **G-14** No deadline margin (`sqs-batch.ts` has no remaining-time input) (FR-007, AS-08).
- **G-15** No `DeadLettered` / `FifoGroupOrderBroken` signal; the handlers do not know the receive limit (FR-009, AS-10). The manifest must carry `maxReceiveCount`.
- **G-16** `SqsRecord` lacks `messageAttributes`, `eventSource`, `awsRegion`, `md5OfBody`, `MessageDeduplicationId`, `SequenceNumber` (`sqs-batch.ts:2-8`) (AS-38).
- **G-17** `webhook-delivery.ts:111` throws a generic `Error('redeliver')` for FIFO retry; use `TransientError` (FR-005, S43 contract).
- **G-18** No dead-letter handler exists for any queue; `onboarding-documents` needs one (S04 contract) (FR-045, AS-34, AS-35).

## D. Idempotency records (FR-020 to FR-030)

- **G-20** `apps/lambdas/src/shared/idempotency.ts:97` claim condition ignores `expiresAtEpoch`: an expired but not yet deleted `COMPLETED` record still replays (AS-18).
- **G-21** `idempotency.ts:113-115` completion is unconditional; a stale holder can overwrite a newer attempt (AS-17). No owner token in the item or in `dynamodb/Idempotency.json`.
- **G-22** `idempotency.ts:117-119` the `catch` wraps both the work and the completion write: if the work succeeded and only the completion failed, the claim is deleted and the finished work runs again (AS-23). The release is also unconditional (AS-16, AS-17).
- **G-23** No fingerprint check (AS-19), no key validation or limit (`idempotency.ts:90`) (AS-21), no result-size limit (`:114`) (AS-22), no lease validation against the function timeout (AS-25).
- **G-24** `Date.now()` at `:91` and no injectable clock (FR-030); the existing e2e uses real `setTimeout` waits (`idempotency.e2e-spec.ts:35,45`) — replace with the fake clock and `waitFor`.
- **G-25** `idempotency.ts:107` reads the stored result with a hand-rolled `JSON.parse(e.Item?.result?.S)`; add the `resultOmitted` branch and a malformed-record guard (a record with no `status` is treated as live conflict, not as a success).
- **G-26** `media-processing.ts:55` passes the literal `120_000` lease; derive it from the manifest timeout (FR-028). The handler also keys by `originalKey` with no tenant component (`:52,55`): include the shop in the key through `idempotencyKey(...)` (FR-026, AS-20) — S29 decides the shop identifier available in the key.
- **G-27** `dynamodb/Idempotency.json` lacks `ownerToken`, `fingerprint`, `resultOmitted`, `completedAt` in its `_design` block.
- **G-28** `webhook-delivery.ts:100-104` and `document-extractor.ts:82-90` rely on "the service's own idempotency" with no record; acceptable only if S43 and S04 prove it in their specs. Keep, but AS-26/AS-27 must pass against a fixture function.

## E. Queue configuration, FIFO, DLQ, redrive (FR-040 to FR-048)

- **G-30** `lambdas.manifest.ts:13-24,34-38` has no `fifo`, `visibilityTimeoutSec`, `maxReceiveCount`, `dbPoolMax`, `deadLetter` and no validation (FR-040 to FR-042, AS-28, AS-30).
- **G-31** `infra/docker/elasticmq/elasticmq.conf`: `webhook-deliveries.fifo` visibility 30 s (needs ≥ 180 s for the 30 s function) and `media-processing` 180 s (needs ≥ 360 s). Terraform (`infra/stack/main.tf:24-25`) already has 180 and 360. Fix and add the conformance spec (AS-29).
- **G-32** No static check of the three queue sources (manifest, ElasticMQ, Terraform) (AS-29).
- **G-33** `infra/modules/lambda_sqs_worker/main.tf:42-46,53-63` one execution role shared by all functions with receive/delete on every function's queue, and no DLQ restriction; idempotency table access only through `extra_policy_json` (FR-048, AS-37).
- **G-34** `main.tf:134-148` only an `Errors` alarm; no DLQ-depth alarm, no queue-age alarm, no throttles alarm (AS-37).
- **G-35** No redrive tooling locally (FR-046, AS-36); cloud redrive allow policy exists (`infra/modules/sqs/main.tf:48-52`) and must be asserted.
- **G-36** Connection budget: no `dbPoolMax`; Nest functions use the shared database module's pool (FR-047, FR-075, AS-30).

## F. Local runner (FR-060 to FR-066)

- **G-40** `main.ts:29` overrides `VisibilityTimeout: spec.timeoutSec * 6` on every receive, hiding queue misconfiguration (G-31), and `:42-44` heartbeats `ChangeMessageVisibility`, which Lambda does not do (FR-061).
- **G-41** `main.ts:29` omits `MessageAttributeNames`, so `traceparent` and every message attribute is lost; `:34-40` builds an incomplete record (AS-38, AS-50).
- **G-42** `main.ts:27-57` one sequential loop per function: `maxConcurrency` is never honoured, and a long invocation blocks the group (AS-41).
- **G-43** `main.ts:47-49` timeout race leaves the handler running with no log of the abandoned execution (AS-40).
- **G-44** `main.ts:56` the delete result is not inspected; failed entries are silent (AS-44). The delete also uses indexes as entry IDs, which is fine.
- **G-45** `main.ts:63-65` the termination handler only flips a flag; the pending 20 s long poll still receives and then discards messages after shutdown was requested, and pump errors (`:65`) end one function silently while the process keeps running (AS-43, AS-45, AS-42).
- **G-46** `main.ts:68` `void main()` at import time: the runner is not callable from a test. Export `startRunner(options)` returning `{ stop() }` (all of `runner/*.e2e-spec.ts` need it).
- **G-47** No start-up validation: missing queue (`:21` throws inside the pump and is swallowed), unknown CLI name filtered out silently (`:62`), unregistered handler (`:23`) (AS-42).
- **G-48** No receive-failure backoff (`:28` throws out of the loop) (AS-45).

## G. Handler styles, bundles, observability (FR-070 to FR-078)

- **G-50** `shared/nest-context.ts:137-139` `ctx.catch(() => contexts.delete(module))` deletes by module key even if a newer promise was stored meanwhile; compare identity before deleting (AS-47). No test exists (AS-46, AS-47).
- **G-51** `shared/telemetry.ts:148-160` no validation of dimensions, value or unit; no trace ID; `Date.now()`/`new Date()` direct; metric names are the callers' strings (FR-077, FR-078, AS-51). Add the standard metrics of FR-078 (today only business metrics exist).
- **G-52** No trace continuation from the `traceparent` attribute inside any function (`handlers/*.ts`) (FR-076, AS-50); the producer side (`libs/infrastructure/sqs/sqs-task-queue.ts:158-160`) already injects it.
- **G-53** `scripts/build-lambdas.mjs`: no dead-letter entries, no bundle checks (single copy of DI core and metadata polyfill, no top-level `await`, handler export, size limit), and `manifest.json` is written from the compiled manifest without validation (FR-072, FR-073, AS-48, AS-49, AS-52). `format: 'cjs'` is already right (P0107) and stays; add the checks as `bundling/build-lambdas.e2e-spec.ts`.
- **G-54** `package.json:73` `start:lambda-local` runs `nest build lambda-local` then the compiled app; the new launcher needs the bundles first (`pnpm build:lambdas`) and the `--redrive` subcommand.
- **G-55** Tests: `shared/sqs-batch.spec.ts` covers 2 of the 12 batch scenarios; `shared/idempotency.e2e-spec.ts` covers AS-14, AS-15, AS-16 and part of AS-17 with real sleeps; nothing exists for the runner, manifest, bundles, dead letters, nest-context or telemetry. All of `test-plan.md` is the to-do list.
- **G-56** `docs/showcase/sections/SD-03-serverless-lambdas.md` says "specs written, not run"; after the implementation, update its implementation notes (the lambda-local heartbeat sentence is wrong after G-40) and `docs/architecture/pattern-map.md` rows P0107, P0604, P0706, P0809 stay `implemented` only once the scenarios above are green.

## H. Contracts to honour from other specs

- S04: dead-letter handler and error classes (G-05, G-18). S43: `WebhooksLambdaModule` and `WebhookDeliveryHandler` (G-06, G-17). S29: `createMediaProcessor` (G-04). S53: `TaskMessage`, `dedupeId`, `traceparent`, `PermanentError`/`TransientError`, `appendWithExecutor` (G-04, G-13, G-17). S54: clock and logger field names (G-24, G-51). Each is listed as a `[CONTRACT]` line in `questions.md`.
