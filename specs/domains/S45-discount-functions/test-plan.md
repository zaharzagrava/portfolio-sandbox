# Test Plan: S45 — Seller discount functions (domain `shop-functions`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (39 rows), each proven at the lowest layer that can prove it. A dash means that layer does not test the scenario. Where both a unit and an e2e entry appear, the unit proves the pure rule table and the e2e proves one wiring case.

## Layout and rules

- API e2e files live in `packages/backend/libs/domains/shop-functions/`, boot the real `ShopFunctionsModule` and `FunctionJudgeModule` (plus the identity, tenancy and billing modules they import) with the production prefix (`/api`), pipe, filter and interceptors, call through `supertest`, run against real Postgres, Redis and the queue/outbox stand-ins with real migrations, freeze time, replace only system-edge dependencies (identity token verification) and assert the response body, the contract schema parse (VII.6) and the persisted state (rows, history, outbox, queue, cache) in every test. Seeds create shops and users; the judge is delivered through the real consumer, never by calling a service method.
  - `shop-functions-management.e2e-spec.ts` — describe "Shop functions: management (functions, suites, reads)"
  - `shop-functions-judge.e2e-spec.ts` — describe "Shop functions: submission, judge and versions" (includes the VII.4 duplicate-delivery and invalid-payload tests of the judge consumer)
  - `shop-functions-checkout.e2e-spec.ts` — describe "Shop functions: evaluation at checkout (fail-safe)"
  - `shop-functions-ops.e2e-spec.ts` — describe "Shop functions: observability and schema invariants"
- Unit specs (table-driven, pure logic only; the sandbox spec runs real sealed runtimes, no mocks): `domain/version-state.spec.ts`, `domain/discount-amount.spec.ts` (with `fast-check`), `domain/breaker.spec.ts`, `infra/sandbox.spec.ts`.
- Fault injection (VII.9): the entitlement lookup is replaced by a failing fake of billing's exported service (a system edge for this domain); function failures use real seller sources that loop, throw and allocate.
- Ops check: `pnpm --dir packages/backend check:function-runner` (new) inspects the runner's container and compose or orchestration artifacts (row AS-23). Static checks: `check:boundaries` and `check:table-ownership --strict` (row AS-38).
- UI journey: none. No web capability owns a function editor (see `questions.md`). When one exists it adds one happy-path Playwright journey ("write, test, activate, see the discount at checkout") and does not re-test any row below.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-02 validation classes | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-03 limits, unique name, concurrent | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-04 permission, tenant, authentication | `shop-functions-management.e2e-spec.ts` (table over every route) | — | — |
| AS-05 entitlement on write routes | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-06 replace the suite | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-07 list, read, cursor | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-08 delete | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-09 enable and disable | `shop-functions-management.e2e-spec.ts` | — | — |
| AS-10 submit, judge, activate | `shop-functions-judge.e2e-spec.ts` | — | — |
| AS-11 submit validation, limits, rate limit | `shop-functions-judge.e2e-spec.ts` | — | — |
| AS-12 concurrent submissions | `shop-functions-judge.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-13 rejection over the API | `shop-functions-judge.e2e-spec.ts` (loop, `require`, wrong output) | — | — |
| AS-14 sandbox containment | — | — | `infra/sandbox.spec.ts` (`it.each` over the table, real runtimes) |
| AS-15 out-of-order judging | `shop-functions-judge.e2e-spec.ts` | — | `domain/version-state.spec.ts` (stale rule) |
| AS-16 one active version, concurrent | `shop-functions-judge.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-17 duplicate and crashed deliveries | `shop-functions-judge.e2e-spec.ts` | — | — |
| AS-18 invalid judge payload | `shop-functions-judge.e2e-spec.ts` | — | — |
| AS-19 stuck versions recovered | `shop-functions-judge.e2e-spec.ts` | — | — |
| AS-20 rollback and illegal transitions | `shop-functions-judge.e2e-spec.ts` (concurrent activate with `Promise.all`) | — | — |
| AS-21 state machine | — | — | `domain/version-state.spec.ts` (`it.each` over every pair, exhaustive check) |
| AS-22 suite frozen per version | `shop-functions-judge.e2e-spec.ts` | — | — |
| AS-23 runner hardening | — (ops check `check:function-runner`) | — | — |
| AS-24 checkout happy path | `shop-functions-checkout.e2e-spec.ts` | — | — |
| AS-25 own-shop input only | `shop-functions-checkout.e2e-spec.ts` | — | — |
| AS-26 output to money | — | — | `domain/discount-amount.spec.ts` (`it.each` and `fast-check`, 10,000 cases) |
| AS-27 several functions | `shop-functions-checkout.e2e-spec.ts` (one wiring case) | — | `domain/discount-amount.spec.ts` (largest wins, order independence) |
| AS-28 fail-safe, every class | `shop-functions-checkout.e2e-spec.ts` (forced loop, throw, memory, invalid output, billing failure) | — | — |
| AS-29 circuit breaker | `shop-functions-checkout.e2e-spec.ts` (shared state, concurrent half-open trial, frozen time) | — | `domain/breaker.spec.ts` (transition table) |
| AS-30 memoization | `shop-functions-checkout.e2e-spec.ts` | — | — |
| AS-31 time budgets | `shop-functions-checkout.e2e-spec.ts` | — | — |
| AS-32 entitlement at checkout | `shop-functions-checkout.e2e-spec.ts` | — | — |
| AS-33 changes take effect, cache correctness | `shop-functions-checkout.e2e-spec.ts` | — | — |
| AS-34 invalid cart input | `shop-functions-checkout.e2e-spec.ts` | — | — |
| AS-35 metrics and logs | `shop-functions-ops.e2e-spec.ts` | — | — |
| AS-36 judge backlog gauge | `shop-functions-ops.e2e-spec.ts` | — | — |
| AS-37 errors and contracts | `shop-functions-ops.e2e-spec.ts` (every error code, contract parse) | — | — |
| AS-38 boundaries and ownership | — (static: `check:boundaries`, `check:table-ownership --strict`) | — | — |
| AS-39 the store enforces invariants | `shop-functions-ops.e2e-spec.ts` (direct SQL attempts against real constraints) | — | — |
