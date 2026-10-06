# Test Plan: S17 — Subscriptions: Plans, Versioned Prices, Subscription State Machine, Billing Run, Proration, Dunning (domain `billing`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (85 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/billing/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `BillingModule`, `BillingWorkerModule` and the tenancy-event consumer module with the production prefix, `ValidationPipe`, problem+json filter and interceptors, against real Postgres (real migrations, constraints and triggers), Redis and the job, outbox, inbox and idempotency tables from `docker-compose.test.yaml`:
  - `plans-catalog.e2e-spec.ts` — describe "Billing: plans and versioned prices" (AS-01–AS-08)
  - `subscribe.e2e-spec.ts` — describe "Billing: subscribing" (AS-09–AS-20)
  - `subscription-lifecycle.e2e-spec.ts` — describe "Billing: subscription state machine, cancel, resume and shop lifecycle" (AS-22–AS-25, AS-71–AS-77)
  - `billing-run.e2e-spec.ts` — describe "Billing: renewal run" (AS-26–AS-29, AS-31–AS-39)
  - `invoice-charging.e2e-spec.ts` — describe "Billing: charging, unknown outcomes and dunning" (AS-40–AS-42, AS-44–AS-58)
  - `subscription-change.e2e-spec.ts` — describe "Billing: plan changes and proration" (AS-59–AS-62, AS-65–AS-69)
  - `billing-reads-events.e2e-spec.ts` — describe "Billing: reads and events" (AS-78–AS-81)
  - `billing-ops.e2e-spec.ts` — describe "Billing: boundaries, secrets, migration and shutdown" (AS-82–AS-85)
- Fixtures: shops are created through the S03 fixtures (owner Ann with `billing.manage`, viewer Vic, shop `b` with owner Bo, a sandbox shop); admins and buyers come from the S01 fixtures; DS-1 prices and the FS subscription are fixture builders under `test/fixtures/billing/`. Subscriptions reach a state only through their real triggers (HTTP, billing run, charge job, event delivery); privileged helpers (test code only, IX.6) are used solely where the scenario says so (price edits AS-05, history and invoice tampering AS-23 and AS-39, aging a period).
- Only system edges are faked: identity token verification, S03's R1 answers (scriptable double behind `ShopScoped` and `ShopQueryService`), the clock (frozen, advanced by the test), the rate limiter's store (forced down in AS-20), S18's `UsageInvoiceLinesProvider` (scriptable: lines, timeout), and the payment provider at its HTTP edge (the `stripe` client's transport: `pm_ok`, `pm_declined`, `pm_auth`, `pm_timeout`, `pm_late`, lookup answers, unclassifiable body, call counts and a spy asserting no DB transaction is open during a call). No project repository, ORM or store is mocked.
- Jobs are invoked through the S49 handler registration (the same path the worker uses), delivering twice and concurrently where the scenario says so; the crash in AS-37 is a fault injected after the Nth commit. Consumers (VII.4) are driven by delivering real envelopes to the real entry point: duplicate delivery in AS-77 (all three consumers), invalid payload in AS-77, ordering in AS-75.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5); money invariants also get `fast-check` properties: `subscription-status.spec.ts` (AS-21 full status × trigger matrix and exhaustiveness), `periods.spec.ts` (AS-30), `dunning-schedule.spec.ts` (AS-43), `proration.spec.ts` (AS-63 day boundaries incl. time zones, AS-64 rounding table and the property `sum(lines) = round(exact net)`, each line within 1 of exact), `allocation.spec.ts` (AS-70 largest-remainder property over generated amounts and weights).
- UI journeys (Playwright, happy path only): none. No web capability owns a billing screen (decision in `questions.md`); the subscribe step is covered by the API journey J02 (`packages/backend/test/journeys/seller-to-first-sale.spec.ts`), which is not a UI test. When a screen exists, its single journey is AS-09 (subscribe) and AS-59/AS-60 (preview then upgrade); no edge case below is re-tested in the UI.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` for billing (AS-82); `check:model-registry`.
- Gate 9 (VII.9) forced faults: AS-20 (limiter down), AS-36 (usage provider down), AS-37 (crash and poison row), AS-48 (provider silent), AS-51 (lookup unreachable), AS-58 (unclassifiable answer), AS-85 (shutdown).
- Concurrency rows (`Promise.all`) are repeated as stated and assert both the invariant (one live subscription; one invoice per business key; consistent history chain; credit balance never negative) and the exact counts (VII.3). Every row asserts the response body **and** the persisted state (rows, histories, jobs, outbox, inbox, idempotency record) (VII.2); every e2e response body is parsed with its `packages/contracts` schema (VII.6).
- Benchmark (not a row): `scripts/bench/billing-run-10k.ts` for SC-001 and SC-002 runs in the performance job, not in e2e.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 catalog read | `plans-catalog.e2e-spec.ts` | — | — |
| AS-02 create a plan (duplicate code, shop codes, entitlements) | `plans-catalog.e2e-spec.ts` | — | — |
| AS-03 publish a new price version | `plans-catalog.e2e-spec.ts` | — | — |
| AS-04 existing subscribers keep their price | `plans-catalog.e2e-spec.ts` (renewal on the retired price) | — | — |
| AS-05 the store refuses a price edit | `plans-catalog.e2e-spec.ts` (privileged statements) | — | — |
| AS-06 price validation and limits | `plans-catalog.e2e-spec.ts` | — | — |
| AS-07 retire a price, twice → 409 | `plans-catalog.e2e-spec.ts` | — | — |
| AS-08 who may write the catalog (401, 403) | `plans-catalog.e2e-spec.ts` | — | — |
| AS-09 a shop subscribes (atomic rows, no provider call) | `subscribe.e2e-spec.ts` | — | — |
| AS-10 a buyer subscribes, no tier event | `subscribe.e2e-spec.ts` | — | — |
| AS-11 trial from the price, anchor day | `subscribe.e2e-spec.ts` | — | — |
| AS-12 trial once per subject | `subscribe.e2e-spec.ts` | — | — |
| AS-13 client cannot pick a trial length | `subscribe.e2e-spec.ts` | — | — |
| AS-14 payment method required when money is due; free price | `subscribe.e2e-spec.ts` | — | — |
| AS-15 eligibility (audience, sandbox, retired price) | `subscribe.e2e-spec.ts` | — | — |
| AS-16 one live subscription, concurrent subscribes; `UNPAID` blocks | `subscribe.e2e-spec.ts` | — | — |
| AS-17 subscribe validation | `subscribe.e2e-spec.ts` | — | — |
| AS-18 credentials and cross-tenant (IDOR) | `subscribe.e2e-spec.ts` | — | — |
| AS-19 idempotency replay, in-flight, different body, missing | `subscribe.e2e-spec.ts` | — | — |
| AS-20 rate limit 429 and limiter down | `subscribe.e2e-spec.ts` | — | — |
| AS-21 transition table is complete and closed, exhaustive | — | — | `subscription-status.spec.ts` (status × trigger matrix, `assertNever`) |
| AS-22 illegal moves at the API → 409 / 404 | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-23 one history row per move, atomic, append-only | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-24 conditional transitions under concurrency (50×) | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-25 `CANCELED` is terminal | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-26 renewal | `billing-run.e2e-spec.ts` | — | — |
| AS-27 due boundary at the millisecond | `billing-run.e2e-spec.ts` | — | — |
| AS-28 concurrent runs (50×) | `billing-run.e2e-spec.ts` | — | — |
| AS-29 the run is scheduled once | `billing-run.e2e-spec.ts` | — | — |
| AS-30 month-end and leap-day anchors, UTC | — | — | `periods.spec.ts` (table: Jan 31 monthly, Feb 29 yearly, server time zone variants) |
| AS-31 a trial ends | `billing-run.e2e-spec.ts` | — | — |
| AS-32 cancellation at the period end | `billing-run.e2e-spec.ts` | — | — |
| AS-33 delinquent subscriptions are not renewed | `billing-run.e2e-spec.ts` | — | — |
| AS-34 unpaid for 30 days is cancelled (boundary) | `billing-run.e2e-spec.ts` | — | — |
| AS-35 catch-up one period per run | `billing-run.e2e-spec.ts` | — | — |
| AS-36 usage lines unavailable → deferred | `billing-run.e2e-spec.ts` | — | — |
| AS-37 poison subscription and crash resume | `billing-run.e2e-spec.ts` | — | — |
| AS-38 batches, ordering, no double claim | `billing-run.e2e-spec.ts` | — | — |
| AS-39 invoices and lines are immutable | `billing-run.e2e-spec.ts` (privileged statements) | — | — |
| AS-40 a successful charge (key, currency, metadata, no open tx) | `invoice-charging.e2e-spec.ts` | — | — |
| AS-41 a decline starts dunning | `invoice-charging.e2e-spec.ts` | — | — |
| AS-42 the full dunning path to `UNPAID` | `invoice-charging.e2e-spec.ts` | — | — |
| AS-43 the schedule is a pure function | — | — | `dunning-schedule.spec.ts` (table: late attempts, month ends) |
| AS-44 an early job does nothing | `invoice-charging.e2e-spec.ts` | — | — |
| AS-45 duplicate and concurrent job delivery (50×) | `invoice-charging.e2e-spec.ts` | — | — |
| AS-46 paying while past due recovers | `invoice-charging.e2e-spec.ts` | — | — |
| AS-47 recovery waits for every invoice in dunning | `invoice-charging.e2e-spec.ts` | — | — |
| AS-48 a silent provider: unknown outcome | `invoice-charging.e2e-spec.ts` | — | — |
| AS-49 the lookup finds the charge (succeeded, failed, awaiting) | `invoice-charging.e2e-spec.ts` | — | — |
| AS-50 lookup finds nothing, the 60-minute boundary | `invoice-charging.e2e-spec.ts` | — | — |
| AS-51 the lookup cannot reach the provider | `invoice-charging.e2e-spec.ts` | — | — |
| AS-52 the card needs customer action | `invoice-charging.e2e-spec.ts` | — | — |
| AS-53 no payment method | `invoice-charging.e2e-spec.ts` | — | — |
| AS-54 zero or negative totals are never charged | `invoice-charging.e2e-spec.ts` | — | — |
| AS-55 a new card gives one extra attempt now | `invoice-charging.e2e-spec.ts` | — | — |
| AS-56 paying an unpaid subscription reactivates it | `invoice-charging.e2e-spec.ts` | — | — |
| AS-57 payment-method route: validation, 401, 404, 403, 429 | `invoice-charging.e2e-spec.ts` | — | — |
| AS-58 an unclassifiable provider answer is unknown | `invoice-charging.e2e-spec.ts` | — | — |
| AS-59 preview | `subscription-change.e2e-spec.ts` | — | — |
| AS-60 upgrade equals preview | `subscription-change.e2e-spec.ts` | — | — |
| AS-61 downgrade becomes credit, applied at renewals | `subscription-change.e2e-spec.ts` | — | — |
| AS-62 seat change | `subscription-change.e2e-spec.ts` | — | — |
| AS-63 the day boundary is a UTC date | — | — | `proration.spec.ts` (table: instants, time zones, zero remaining) |
| AS-64 rounding once, half away from zero, parts sum | — | — | `proration.spec.ts` (table of the four worked cases + `fast-check` property) |
| AS-65 a change while trialing | `subscription-change.e2e-spec.ts` | — | — |
| AS-66 refused changes | `subscription-change.e2e-spec.ts` | — | — |
| AS-67 concurrent changes (50×) | `subscription-change.e2e-spec.ts` | — | — |
| AS-68 change versus renewal at the boundary (50×) | `subscription-change.e2e-spec.ts` | — | — |
| AS-69 change and preview: validation, 401, 404, 403, idempotency, 429 | `subscription-change.e2e-spec.ts` | — | — |
| AS-70 largest-remainder split is exact | — | — | `allocation.spec.ts` (`fast-check`: sum, ±1, tie order) |
| AS-71 cancel at period end | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-72 cancel immediately | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-73 resume | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-74 cancel and resume: validation, 401, 404, 403 | `subscription-lifecycle.e2e-spec.ts` | — | — |
| AS-75 offboarding stops billing; out-of-order cancel | `subscription-lifecycle.e2e-spec.ts` (consumer) | — | — |
| AS-76 a deleted shop | `subscription-lifecycle.e2e-spec.ts` (consumer) | — | — |
| AS-77 consumers: duplicate delivery and invalid payload | `subscription-lifecycle.e2e-spec.ts` (consumer) | — | — |
| AS-78 read the subscription | `billing-reads-events.e2e-spec.ts` | — | — |
| AS-79 invoice history, keyset pages, after cancellation | `billing-reads-events.e2e-spec.ts` | — | — |
| AS-80 invoice detail and cross-tenant | `billing-reads-events.e2e-spec.ts` | — | — |
| AS-81 plan tier events are versioned per shop | `billing-reads-events.e2e-spec.ts` | — | — |
| AS-82 ownership and boundaries | static gates + `billing-ops.e2e-spec.ts` (registry assertion) | — | — |
| AS-83 no payment data in logs, responses, events | `billing-ops.e2e-spec.ts` | — | — |
| AS-84 expand-only migration on live data | `billing-ops.e2e-spec.ts` (migration run on a seeded old schema) | — | — |
| AS-85 graceful shutdown | `billing-ops.e2e-spec.ts` | — | — |
