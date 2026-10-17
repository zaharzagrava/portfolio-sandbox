---
id: S45
title: Seller discount functions (sealed runtime, online judge, versions, checkout evaluation with circuit breaker)
kind: capability
status: draft
depends_on: [S01, S03, S10, S18, S49, S50, S53, S54]
concepts: [outbox-task-queue, rate-limit-policy, problem-json-errors, tenant-shop-rbac, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/shop-functions/domain/*.ts
  - packages/backend/libs/domains/shop-functions/application/*.ts
  - packages/backend/libs/domains/shop-functions/application/events/*.ts
  - packages/backend/libs/domains/shop-functions/api/*.ts
  - packages/backend/libs/domains/shop-functions/infra/*.ts
  - packages/backend/libs/domains/shop-functions/infra/models/*.ts
  - packages/backend/libs/domains/shop-functions/runner/*.ts
  - packages/backend/libs/domains/shop-functions/*.module.ts
  - packages/contracts/src/shop-functions/*.ts
---
# S45 - Seller discount functions (sealed runtime, online judge, versions, checkout evaluation with circuit breaker)
## Purpose
A shop on a plan that includes discount functions writes a small JavaScript function that turns the lines of its own cart into discounts, together with a suite of test cases. A submitted version is judged asynchronously against a frozen copy of the suite in a sealed runtime; only a version that passes every case becomes the shop's active version, and failing code never replaces working code. At checkout the platform evaluates the active functions of every shop in the cart in parallel, within a hard time budget, behind a per-function circuit breaker, and returns one integer discount amount per shop. Evaluation never fails the checkout: any problem means no discount for the affected function.

## Entry points
- Management routes under `/api/shops/:shopId/functions` (create, list, read, delete, enable, disable, read and replace the test suite). [code: packages/backend/libs/domains/shop-functions/api/shop-functions.controller.ts#ShopFunctionsController]
- Version routes under `/api/shops/:shopId/functions/:functionId/versions` (submit, list, read, activate). [code: packages/backend/libs/domains/shop-functions/api/function-versions.controller.ts#FunctionVersionsController]
- `DiscountEvaluationService.evaluateDiscounts(cart)`, called by orders at checkout. [code: packages/backend/libs/domains/shop-functions/application/discount-evaluation.service.ts#DiscountEvaluationService]
- Consumer of the task queue `shop-functions.judge-version` (worker app). [code: packages/backend/libs/domains/shop-functions/infra/judge.consumer.ts#JudgeConsumer]
- Job `shop-functions.recover-stuck-versions` (every minute, one run in the fleet). [code: packages/backend/libs/domains/shop-functions/infra/judge.jobs.ts#JudgeJobs]

## Rules
- **S45.R-01** Every route MUST require an authenticated member of the shop in the path with the permission `FUNCTIONS_PERMISSION` (OWNER and ADMIN); other roles get `403`, non-members `404`, anonymous `401`; a function of another shop answers the same `404 function_not_found` as an unknown one. [proof: S45 AS-04] [code: packages/backend/libs/domains/shop-functions/api/shop-functions.controller.ts#ShopFunctionsController]
- **S45.R-02** Routes that create or change seller code or its suite (create, tests replace, submit, enable, activate) MUST require the shop entitlement `shopFunctions` (`403 entitlement_required`); reads, disable and delete never do. [proof: S45 AS-05] [code: packages/backend/libs/domains/shop-functions/infra/billing-entitlements.adapter.ts#BillingEntitlementsAdapter]
- **S45.R-03** A function name MUST be 1 to 60 characters and unique per shop ignoring case; a shop MUST hold at most 3 functions, also under concurrency. [proof: S45 AS-03] [code: packages/backend/libs/domains/shop-functions/infra/pg-function.repository.ts#PgFunctionRepository]
- **S45.R-04** A suite MUST have 1 to 50 cases with unique names and valid inputs and expected outputs; unknown properties and invalid cases are refused (`validation_failed`, `invalid_test_case`). [proof: S45 AS-02, S45 AS-06] [code: packages/backend/libs/domains/shop-functions/application/functions.service.ts#FunctionsService]
- **S45.R-05** Lists MUST page by keyset (`createdAt` or `version` descending, opaque cursor, `limit` at most 50). [proof: S45 AS-07] [code: packages/backend/libs/domains/shop-functions/infra/pg-function.repository.ts#PgFunctionRepository]
- **S45.R-06** Deleting a function MUST remove its versions, history and cases and drop the evaluation caches; disabling and enabling MUST be conditional (`409 function_state_conflict` when repeated). [proof: S45 AS-08, S45 AS-09] [code: packages/backend/libs/domains/shop-functions/application/functions.service.ts#FunctionsService]
- **S45.R-07** Submitting a version MUST assign the next number without gaps under concurrency, freeze the suite, write the history row and the judge request in one transaction and answer `202`; a function holds at most 100 versions and a shop may submit 10 per hour. [proof: S45 AS-10, S45 AS-11, S45 AS-12, S45 AS-22] [code: packages/backend/libs/domains/shop-functions/application/versions.service.ts#VersionsService]
- **S45.R-08** Version status MUST follow the transition table (QUEUED, TESTING, ACTIVE, REJECTED, SUPERSEDED) only; every transition is a conditional update with a history row, and the store allows one ACTIVE version per function. [proof: S45 AS-16, S45 AS-21, S45 AS-39] [code: packages/backend/libs/domains/shop-functions/domain/version-state.ts#transition]
- **S45.R-09** A passing version newer than the active one MUST become ACTIVE (the previous one SUPERSEDED), an older passing one SUPERSEDED with reason `stale`, a failing one REJECTED without touching the active version. [proof: S45 AS-10, S45 AS-13, S45 AS-15] [code: packages/backend/libs/domains/shop-functions/application/judge.service.ts#JudgeService]
- **S45.R-10** Rollback MUST activate only a SUPERSEDED version that passed (`409 version_not_activatable` otherwise) and exactly one of concurrent identical requests succeeds. [proof: S45 AS-20] [code: packages/backend/libs/domains/shop-functions/application/versions.service.ts#VersionsService]
- **S45.R-11** Judging MUST be idempotent under duplicate, concurrent and crashed deliveries; an invalid payload is dead-lettered without effect. [proof: S45 AS-17, S45 AS-18] [code: packages/backend/libs/domains/shop-functions/infra/judge.consumer.ts#JudgeConsumer]
- **S45.R-12** A version stuck in QUEUED or TESTING for 2 minutes MUST be re-requested each minute, five attempts at most, then REJECTED with `judge_unavailable`. [proof: S45 AS-19] [code: packages/backend/libs/domains/shop-functions/application/judge-recovery.service.ts#JudgeRecoveryService]
- **S45.R-13** Seller code MUST run in a fresh isolate per run with a 32 MB heap, a wall-clock limit and no host access; its output is validated strictly and capped at 64 KiB; no state survives a run. [proof: S45 AS-14] [code: packages/backend/libs/domains/shop-functions/infra/sandbox.ts#FunctionSandbox]
- **S45.R-14** The judge MUST execute seller code only in the function runner, whose container profile has no network, a read-only root, a non-root user and no secrets. [proof: S45 AS-23] [code: packages/backend/libs/domains/shop-functions/infra/runner.client.ts#RunnerClient]
- **S45.R-15** `evaluateDiscounts` MUST return one integer per shop with a discount greater than 0 and never reject; money is integer arithmetic with `floor`, clamped per line and per shop. [proof: S45 AS-24, S45 AS-26, S45 AS-27, S45 AS-34] [code: packages/backend/libs/domains/shop-functions/domain/discount-amount.ts#shopDiscount]
- **S45.R-16** Seller code MUST receive only its own shop's lines, with no shop id or personal data. [proof: S45 AS-25] [code: packages/backend/libs/domains/shop-functions/application/discount-evaluation.service.ts#DiscountEvaluationService]
- **S45.R-17** Any failure of a function (timeout, memory, error, invalid output, billing, store or cache failure) MUST give no discount for it and leave the call resolved. [proof: S45 AS-28] [code: packages/backend/libs/domains/shop-functions/application/discount-evaluation.service.ts#DiscountEvaluationService]
- **S45.R-18** Each function MUST have a circuit breaker shared across instances: 5 failures in 60 s open it for 300 s, then one trial call decides. [proof: S45 AS-29] [code: packages/backend/libs/domains/shop-functions/domain/breaker.ts#recordFailure]
- **S45.R-19** Results MUST be memoized per version and canonical input for 60 s (failures never) and the active set cached for at most 60 s and dropped after every change. [proof: S45 AS-30, S45 AS-33] [code: packages/backend/libs/domains/shop-functions/application/active-set.service.ts#ActiveSetService]
- **S45.R-20** A call MUST resolve within 200 ms, returning the shops that finished. [proof: S45 AS-31] [code: packages/backend/libs/domains/shop-functions/application/discount-evaluation.service.ts#DiscountEvaluationService]
- **S45.R-21** Evaluation MUST read entitlements in one batch per call and apply them on the next call without resubmission. [proof: S45 AS-32] [code: packages/backend/libs/domains/shop-functions/infra/billing-entitlements.adapter.ts#BillingEntitlementsAdapter]
- **S45.R-22** Metrics and logs MUST use the closed labels of the contract and never carry source, test data, discount messages or ids. [proof: S45 AS-35, S45 AS-36] [code: packages/backend/libs/domains/shop-functions/application/shop-functions.metrics.ts#shopFunctionsMetrics]
- **S45.R-23** Every error MUST be problem+json with the stable codes of the contract. [proof: S45 AS-37] [code: packages/backend/libs/domains/shop-functions/domain/errors.ts#ShopFunctionError]
- **S45.R-24** The [entry point](../terms/entry-point.md) MUST export the modules, `DiscountEvaluationService`, the two DTO types and the function-runner's `startRunnerServer` only. [proof: S45 AS-38] [code: packages/backend/libs/domains/shop-functions/index.ts]

## Behaviors
- **S45.B-01** Given an entitled ADMIN and a function with a three-case suite, when they submit a source that passes, then the version is `QUEUED` with `202`, the judge makes it `ACTIVE` with one verdict per case and a three-row timeline, and the next checkout applies it. [proof: S45 AS-10, S45 AS-24]
- **S45.B-02** Given an active function that throws five times in a minute, when a sixth cart arrives, then the function is skipped, the breaker shows `OPEN`, and the cart still resolves with no discount from it. [proof: S45 AS-28, S45 AS-29]
- **S45.B-03** Given a version that loops forever, when it is judged, then it is `REJECTED` with a `timeout` verdict and the previous version keeps serving. [proof: S45 AS-13]

## Lifecycles
A version is `QUEUED`, then `TESTING`, then `ACTIVE`, `REJECTED` or `SUPERSEDED`; a superseded version that passed can be rolled back to `ACTIVE`. The breaker of a function is `CLOSED`, `OPEN` or `HALF_OPEN`.

## Owns
Tables `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionTestCase`, `ShopFunctionVersionHistory`; Redis keys `shopfn:*` (all derived, all with a TTL); outbox task `shop_functions.judge_requested` and queue `shop-functions.judge-version`; job `shop-functions.recover-stuck-versions`; rate-limit policy `shop-functions.submit.shop`; the `function-runner` deployable.

## Decisions
- Until S03 defines `functions.manage` the routes use the permission constant `FUNCTIONS_PERMISSION = 'shop.manage'` (same roles). [code: packages/backend/libs/domains/shop-functions/api/permissions.ts#FUNCTIONS_PERMISSION]
- Until S18 defines the `shopFunctions` entitlement an unknown key means not entitled (fail closed). [code: packages/backend/libs/domains/shop-functions/infra/billing-entitlements.adapter.ts#SHOP_FUNCTIONS_ENTITLEMENT]

## Known gaps
- The p95 latency of a warm evaluation (SC-002), the judge duration (SC-004) and the container profile of the running runner (AS-23) are not proven by an automated test; see the ops artifacts of the quickstart.
- No web screen edits functions; the API is the only surface.
