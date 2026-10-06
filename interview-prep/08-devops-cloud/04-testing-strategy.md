# Testing Strategy for Node.js / Full-Stack Systems

---

## 1. Test portfolio: the pyramid and the trophy

```
           ▲  E2E (Playwright)           few, critical user journeys, slow, flaky-prone
          ▲▲▲ Contract tests (Pact)       service boundaries
        ▲▲▲▲▲ Integration (real DB/Redis via Testcontainers)   ← most value for backend APIs
      ▲▲▲▲▲▲▲ Unit (pure domain logic)    fast, many, table-driven
  ▬▬▬▬▬▬▬▬▬▬▬ Static: TypeScript strict, ESLint, schema validation
```
- Kent C. Dodds' **testing trophy** argues for a large integration layer. That fits most Node APIs, which are mostly I/O plus glue code.
- For **computation engines** (pricing, commission and other financial calculations), invest heavily in **unit tests of pure functions**: exhaustive, table-driven, property-based.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [testing](../../docs/humans/concepts/common-testing/testing.md): The testing module defines a TestCleanupPort for registering test data cleanup in infrastructure modules, supporting the integration-heavy portfolio.
<!-- theory-links:end -->

---

## 2. Unit tests: making domain logic testable

- Keep computation **pure**: inputs (data plus config plus "now") → outputs. Inject the clock (`now: Date`) rather than calling `new Date()` inside the function.
- **Table-driven tests** for financial rules:
  ```ts
  describe.each([
    // period,     attainment, baseCents, expectedCommissionCents
    ['2026-Q1',    0.95,       100_000n,  9_500n],
    ['2026-Q1',    1.20,       100_000n,  15_000n],   // capped at 150%? verify rule
    ['2026-Q1',    0.00,       100_000n,  0n],
  ])('quarterly commission %s attainment=%d', (period, attainment, base, expected) => {
    it('computes', () => expect(computeCommission({ period, attainment, base })).toBe(expected));
  });
  ```
- **Property-based testing** (`fast-check`) for invariants:
  ```ts
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1 }),
    (total, weights) => allocate(total, weights).reduce((a, b) => a + b, 0n) === total));   // allocation never loses a cent
  ```
- **Golden files / snapshot datasets**: real anonymized historical periods with outputs approved by finance. Any change in output fails the test and requires explicit sign-off. This is how you back up a claim of financial accuracy.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`FakeClock`](../../packages/backend/libs/common/core/clock.ts#L20): FakeClock is a settable test Clock that makes time-dependent domain logic deterministic. _(clock.ts)_
> - [`Clock`](../../packages/backend/libs/common/core/clock.ts#L6): The abstract Clock injects the time source (now/nowMs) instead of calling new Date() inside domain functions. _(clock.ts)_
> - [Largest-remainder allocation algorithm](../../docs/humans/concepts/domain-payments/largest-remainder-allocation.md): The largest-remainder allocation is pure financial logic suited to table-driven and property-based tests. [`allocate`](../../packages/backend/libs/domains/payments/infra/settlement.listener.ts#L9)
<!-- theory-links:end -->

---

## 3. Integration tests with real dependencies

- **Testcontainers** starts real Postgres and Redis in Docker for the test run. Mocking the ORM hides real bugs (SQL errors, constraints, isolation behavior, migrations).
- Test isolation strategies:
  - Wrap each test in a **transaction and roll back**. Fast, but code that opens its own transactions or uses several connections won't see the data.
  - **Truncate tables** between tests (`TRUNCATE ... RESTART IDENTITY CASCADE`). Simple and reliable.
  - **Template databases** (`CREATE DATABASE test_x TEMPLATE migrated_template`) per worker for parallel runs.
- Run **real migrations** in tests, so migrations get tested too.
- Test **concurrency** explicitly: fire two concurrent requests and assert no double spend (lost-update tests).
- HTTP-level tests with `supertest` against the Nest app, overriding external clients (bank, LLM) with fakes.
- External HTTP: `nock`/`msw`, or undici `MockAgent` for fetch. Prefer **fakes** (an in-memory implementation of the port interface) over deep mocks.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`TEST_CLEANUP`](../../packages/backend/libs/common/testing/test-cleanup.port.ts#L11): The TEST_CLEANUP token injects the TestCleanupPort so real DB modules can clean test data between tests. _(test-cleanup.port.ts)_ · [testing](../../docs/humans/concepts/common-testing/testing.md)
> - [`CassandraModule`](../../packages/backend/libs/infrastructure/cassandra/cassandra.module.ts#L14): CassandraModule exposes test cleanup for integration tests against the real database. _(cassandra.module.ts)_ · [cassandra](../../docs/humans/concepts/platform-cassandra/cassandra.md)
> - [`RedisModule`](../../packages/backend/libs/infrastructure/redis/redis.module.ts#L14): RedisModule is a global module with health checks and test support for running against a real Redis. _(redis.module.ts)_ · [redis](../../docs/humans/concepts/platform-redis/redis.md)
<!-- theory-links:end -->

---

## 4. Contract tests

- **Consumer-driven contracts (Pact)**: the consumer's tests produce a contract (expected requests and responses), and the provider's CI verifies it against the real provider. Breaking changes are caught **before deploy**, and you can see exactly which consumers use what (useful for deprecations!).
- Schema-based alternative: OpenAPI spec as the contract, validating responses against it in tests (e.g. `jest-openapi`), plus breaking-change detection on spec diffs (`oasdiff`).
- For events: schema registry compatibility checks.

---

## 5. E2E tests

- **Playwright**: a few critical journeys (sign up, search, add to cart, pay). Run against a preview or staging environment.
- Flakiness control: deterministic test data, no fixed `sleep` (use auto-waiting and web-first assertions), isolated users per test, retries with trace recording for diagnosis, quarantine for flaky tests.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`web/playwright.config.ts`](../../packages/web/playwright.config.ts): playwright.config.ts configures the web package's Playwright E2E tests with CI-aware settings and dev server startup.
<!-- theory-links:end -->

---

## 6. Frontend testing

- **React Testing Library**: test behavior the way users see it (`getByRole`) rather than implementation details.
- MSW to mock the network at the boundary.
- Visual regression (Chromatic, Playwright screenshots) for design systems.
- Accessibility checks (`axe`).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`web/vitest.config.ts`](../../packages/web/vitest.config.ts): vitest.config.ts runs unit tests for lib/ and hooks/ in a jsdom environment.
<!-- theory-links:end -->

---

## 7. Non-functional testing

- **Load tests** (k6) with SLO-based thresholds, on production-like data volumes.
- **Chaos / resilience** testing: kill pods, inject latency into dependencies (Toxiproxy), verify that timeouts, breakers, and fallbacks actually work.
- **Security**: SAST (Semgrep, CodeQL), dependency scanning, DAST (OWASP ZAP) against staging, secret scanning (gitleaks).
- **Migration testing**: apply to a production-sized snapshot, measure locks and duration.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`k6Thresholds`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L80): k6Thresholds derives k6 load-test thresholds from the SLO rules. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`options`](../../packages/backend/scripts/load-tests/launch-event.test.js#L24): The launch-event k6 script sets a ramping-vus executor up to 20k users with performance thresholds. _(launch-event.test.js)_
> - [`baseThresholds`](../../packages/backend/scripts/load-tests/lib/config.js#L40): baseThresholds defines the shared k6 thresholds for checks, login duration and failure counts. _(config.js)_
<!-- theory-links:end -->

---

## 8. What to test for an A/B testing system

- Assignment **determinism**: the same user and experiment always get the same variant (hash-based).
- Distribution: over 100k simulated users, the split is within tolerance of 50/50 (a chi-square test). This catches **sample ratio mismatch** bugs.
- Exposure events: emitted exactly when the user sees the variant, deduplicated, and still delivered when the page unloads (`sendBeacon`).
- Ingestion: idempotent on event ID, handles out-of-order and late events, schema validation.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`srmCheck`](../../packages/backend/libs/domains/experimentation/domain/stats.ts#L76): srmCheck detects sample ratio mismatch with a chi-square goodness-of-fit test on exposure counts. _(stats.ts)_
> - [`chiSquarePValue`](../../packages/backend/libs/domains/experimentation/domain/stats.ts#L72): chiSquarePValue computes the p-value used in the split-distribution check. _(stats.ts)_
> - [`AnalyticsService`](../../packages/backend/libs/domains/experimentation/application/analytics.service.ts#L13): AnalyticsService assigns variants, logs exposures and runs SRM checks. _(analytics.service.ts)_
<!-- theory-links:end -->

---

## Interview Q&A

**Q: Mock the database or use a real one?**
For repositories and services touching SQL, use a real Postgres via Testcontainers, since constraints, transactions, and query semantics are exactly where the bugs are. Mock at the system's edges (third-party HTTP) with fakes. Pure domain logic gets plain unit tests without I/O.

**Q: How do you ensure financial calculations are correct?**
Pure computation modules with table-driven tests for every rule and edge case (period boundaries, proration, rounding), property-based tests for invariants (allocations sum to the total, adjustments reconcile), golden datasets of historical periods validated with finance, and reconciliation checks in production that compare computed and actual numbers.
