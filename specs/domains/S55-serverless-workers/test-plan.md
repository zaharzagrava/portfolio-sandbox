# Test Plan: S55 — Lambda workers (domain `infrastructure`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (AS-01 to AS-52), each proven at the lowest layer that can prove it. A dash means that layer does not test the scenario. All paths are under `packages/backend/libs/infrastructure/serverless/` unless stated.

- **No HTTP endpoint exists.** The "API e2e (deep layer)" column holds library-level end-to-end specs, like S53: they run against real engines from `docker-compose.test.yaml` (DynamoDB local, ElasticMQ with FIFO and dead-letter queues, Postgres 18 with real migrations) with a frozen clock (the injectable clock) and `waitFor` polling, never fixed sleeps. Only system edges are faked (the LLM provider, the third-party webhook receiver, the object store). Fault injection (a failing completion write, a stopped queue service) is applied at the network edge of the store, not by mocking our own code.
- Each e2e test asserts the return value **and** the persisted state: idempotency records, queue contents (visible, in flight, dead-letter), effect rows, log lines and metric lines captured from the output stream (VII.2).
- Async consumers (VII.4): AS-26 delivers the same message twice and asserts one effect; AS-06 sends an invalid payload and asserts it is rejected with no side effect.
- Unit specs are beside the code, table-driven (`it.each`), and only for pure logic (VII.5). AS-09 also has a `fast-check` property.
- Static checks (VII.1): `tsc --noEmit`, ESLint, `pnpm check:boundaries` (infrastructure imports no domain; nothing imports `apps/`), `pnpm check:table-ownership --strict` (this capability touches no Postgres table).
- **UI journeys: none.** The capability has no screen; the user-visible effect of each function is proven by the owning capability (S04, S29, S43).
- Wiring of real functions (webhook delivery, photo processing, KYC extraction and its dead-letter handler) is proven by invoking the **built bundles** (`dist/lambda-bundles/<name>/index.js`) in `workers-wiring.e2e-spec.ts`, so the specs never import from `apps/`.
- Every degradation path (store down, broker down, completion write failure, handler timeout, dead-letter handler failure, metric drop) has a forcing test (VII.9). A bug fix adds a test that fails without it.
- Contract layer (VII.6): `manifest.json` parses with the manifest schema (AS-52); queue configuration files parse with the same schema (AS-29).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 | — | — | `batch/sqs-batch.spec.ts` (standard: only `b` reported, one call each) |
| AS-02 | — | — | `batch/sqs-batch.spec.ts` (`it.each`: all ok, all fail, empty) |
| AS-03 | — | — | `batch/sqs-batch.spec.ts` (FIFO suffix failure) |
| AS-04 | — | — | `batch/sqs-batch.spec.ts` (controllable promises: groups parallel, group sequential) |
| AS-05 | — | — | `batch/sqs-batch.spec.ts` (max in flight 2) |
| AS-06 | `batch/define-sqs-handler.e2e-spec.ts`: invalid JSON and schema failure through a real queue and the runner, no effect row, log has no body | — | `batch/define-sqs-handler.spec.ts` (`it.each` bad bodies: handler not called, failure class) |
| AS-07 | — | — | `batch/sqs-batch.spec.ts` (`it.each` thrown values) |
| AS-08 | — | — | `batch/sqs-batch.spec.ts` (fake remaining time, standard and FIFO) |
| AS-09 | — | — | `batch/sqs-batch.property.spec.ts` (`fast-check`: invariants a, b, c over random batches) |
| AS-10 | — | — | `batch/define-sqs-handler.spec.ts` (receive count 4 vs 5, standard vs FIFO, metric lines) |
| AS-11 | — | — | `batch/define-sqs-handler.spec.ts` (log line fields, body and attributes absent) |
| AS-12 | — | — | `batch/define-sqs-handler.spec.ts` (init rejects: invocation rejects, no record handler ran) |
| AS-13 | `idempotency/idempotency.e2e-spec.ts`: record read back mid-flight and after completion, frozen clock | — | — |
| AS-14 | `idempotency/idempotency.e2e-spec.ts`: replay, work counter 1, record unchanged | — | — |
| AS-15 | `idempotency/idempotency.e2e-spec.ts`: `Promise.all` two deliveries, one record | — | — |
| AS-16 | `idempotency/idempotency.e2e-spec.ts`: failure releases only own token, retry runs | — | — |
| AS-17 | `idempotency/idempotency.e2e-spec.ts`: lease expires on the fake clock, B completes, A's completion and release rejected with `StaleClaimError` | — | — |
| AS-18 | `idempotency/idempotency.e2e-spec.ts`: completed but past expiry (store not yet deleted) runs again | — | — |
| AS-19 | `idempotency/idempotency.e2e-spec.ts`: fingerprint mismatch on `COMPLETED` and `IN_PROGRESS`, record unchanged | — | — |
| AS-20 | `idempotency/idempotency.e2e-spec.ts`: two functions, two tenants' keys | — | `idempotency/idempotency-key.spec.ts` (tenant-qualified keys differ) |
| AS-21 | — | — | `idempotency/idempotency-key.spec.ts` (`it.each` empty, 513, control character, empty part; no store call) |
| AS-22 | `idempotency/idempotency.e2e-spec.ts`: 64 KiB stored, 64 KiB + 1 omitted, replay | — | — |
| AS-23 | `idempotency/idempotency.e2e-spec.ts`: completion write fails once (edge fault), claim stays, in-lease duplicate in progress, post-lease rerun, metric | — | — |
| AS-24 | `idempotency/idempotency.e2e-spec.ts`: store unreachable on claim, work not run, transient classification | — | — |
| AS-25 | — | — | `idempotency/idempotency-options.spec.ts` (`it.each` lease 0, negative, below function timeout) |
| AS-26 | `workers-wiring.e2e-spec.ts` (fixture function): same message twice through the runner, one effect row, record `COMPLETED` | — | — |
| AS-27 | `workers-wiring.e2e-spec.ts` (fixture function): two messages, same business key, one effect | — | — |
| AS-28 | — | — | `manifest/manifest.spec.ts` (`it.each` 179 s fails, 180 s passes, dead-letter entry) |
| AS-29 | — | — | `manifest/queue-config-conformance.spec.ts` (parses `infra/docker/elasticmq/elasticmq.conf` and `infra/stack/main.tf`, reports file and field) |
| AS-30 | — | — | `manifest/manifest.spec.ts` (`it.each` one rule violation per row, connection budget sum) |
| AS-31 | `runner/fifo-semantics.e2e-spec.ts`: dedupe within window, order per group, one batch per group in flight, groups concurrent | — | — |
| AS-32 | `runner/fifo-semantics.e2e-spec.ts`: poison `a1` blocks `a2` only, `b1` immediate, `a1` to DLQ at receive 3, `a2` then processed, metric once | — | — |
| AS-33 | `runner/dead-letter.e2e-spec.ts`: standard queue, 3 receives, DLQ holds body, group, attributes | — | — |
| AS-34 | `workers-wiring.e2e-spec.ts`: built `document-extractor-dead-letter` bundle, real Postgres, document in review state, queue empty | — | — |
| AS-35 | `workers-wiring.e2e-spec.ts`: `routeToReview` failure keeps the message, retry after visibility, metric; duplicate after success routes once | — | — |
| AS-36 | `runner/dead-letter.e2e-spec.ts`: redrive three messages incl. FIFO, fresh dedupe ID, count printed, empty queue moves 0 | — | — |
| AS-37 | — | — | `manifest/terraform-conformance.spec.ts` (parses `infra/modules/lambda_sqs_worker` and `infra/modules/sqs`: failure reporting, per-function roles, alarms, retention, redrive allow) |
| AS-38 | `runner/local-runner.e2e-spec.ts`: full record shape for standard and FIFO, attributes incl. `traceparent` round trip | — | — |
| AS-39 | `runner/local-runner.e2e-spec.ts`: failed record visible again with receive count 2, no visibility extension call | — | — |
| AS-40 | `runner/local-runner.e2e-spec.ts`: throwing and never-returning function, no deletes, redelivery, log lines | — | — |
| AS-41 | `runner/local-runner.e2e-spec.ts`: 20 messages, batch ≤ 5, ≤ 2 in flight, each processed once | — | — |
| AS-42 | `runner/local-runner.e2e-spec.ts`: four start-up failures, non-zero exit, zero receive calls | — | — |
| AS-43 | `runner/local-runner.e2e-spec.ts`: termination signal mid-invocation, successes deleted, exit 0 | — | — |
| AS-44 | `runner/local-runner.e2e-spec.ts`: delete reports failed entries, logged, redelivered | — | — |
| AS-45 | `runner/local-runner.e2e-spec.ts`: queue service stopped and restarted, backoff 1 s to 30 s on the fake clock, resumes | — | — |
| AS-46 | `context/nest-context.e2e-spec.ts`: counter provider, three invocations, one init | — | — |
| AS-47 | `context/nest-context.e2e-spec.ts`: first init fails, second succeeds, other module unaffected | — | — |
| AS-48 | `bundling/build-lambdas.e2e-spec.ts`: runs the build, one CJS bundle per entry, `handler` is a function, no top-level `await`, plain bundle has no Nest | — | — |
| AS-49 | `bundling/build-lambdas.e2e-spec.ts`: source maps list one copy of DI core, metadata polyfill, validator; no AWS SDK; size limit | — | — |
| AS-50 | `runner/local-runner.e2e-spec.ts`: producer span → message → function span, same trace ID, parent id, log lines carry trace and message IDs | — | — |
| AS-51 | — | — | `telemetry/telemetry.spec.ts` (`it.each` valid line shape; 4 dimensions, `NaN`, unknown unit dropped with a warning, never throws) |
| AS-52 | `bundling/build-lambdas.e2e-spec.ts`: `manifest.json` equals the manifest (schema parse), runner starts from it | — | — |

## Coverage check

- 52 scenarios, 52 rows, each in exactly one row. Edge cases from the spec's list map to: concurrency (AS-04, AS-05, AS-15, AS-41), idempotent replay (AS-14, AS-26, AS-27), stale holder and illegal state (AS-17, AS-19), cross-tenant (AS-20), limits (AS-21, AS-22, AS-30, AS-49), timeouts (AS-08, AS-25, AS-40), duplicate and out-of-order delivery (AS-03, AS-26, AS-31, AS-32), poison and dead letters (AS-06, AS-32 to AS-36).
- Files: unit — `batch/sqs-batch.spec.ts`, `batch/sqs-batch.property.spec.ts`, `batch/define-sqs-handler.spec.ts`, `idempotency/idempotency-key.spec.ts`, `idempotency/idempotency-options.spec.ts`, `manifest/manifest.spec.ts`, `manifest/queue-config-conformance.spec.ts`, `manifest/terraform-conformance.spec.ts`, `telemetry/telemetry.spec.ts`. E2E — `idempotency/idempotency.e2e-spec.ts`, `batch/define-sqs-handler.e2e-spec.ts`, `runner/local-runner.e2e-spec.ts`, `runner/fifo-semantics.e2e-spec.ts`, `runner/dead-letter.e2e-spec.ts`, `context/nest-context.e2e-spec.ts`, `bundling/build-lambdas.e2e-spec.ts`, `workers-wiring.e2e-spec.ts`.
- The existing `apps/lambdas/src/shared/sqs-batch.spec.ts` and `idempotency.e2e-spec.ts` move into the files above (their three scenarios are AS-01, AS-03, AS-14/AS-15/AS-16/AS-17).
