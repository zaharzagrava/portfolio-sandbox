# Test Plan: S43 — Webhook delivery to shops (domain `developer-platform`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (71 rows), each proven at the lowest layer that can prove it. A dash means that layer does not test the scenario. Where both a unit and an e2e entry appear, the unit proves the pure rule table and the e2e proves one wired case through the real modules, never the table again.

## Layout and rules

- API e2e files live in `packages/backend/libs/domains/developer-platform/`, boot the real `WebhooksModule`, `WebhooksWorkerModule`, `WebhooksProjectorModule` and the Lambda-hosting module (plus the tenancy, identity, orders, catalog and rate-limit modules they import) with the production prefix (`/api`), pipe, filter and interceptors, and call through `supertest`. The old `webhooks.e2e-spec.ts` is split into the files below and deleted.
  - `webhook-endpoints.e2e-spec.ts` — describe "Webhooks: endpoint management (dashboard)"
  - `webhook-secrets.e2e-spec.ts` — describe "Webhooks: signing and secret rotation"
  - `webhook-routing.e2e-spec.ts` — describe "Webhooks: routing of domain events (consumers)" (includes the VII.4 duplicate-delivery and invalid-payload tests of the router and of the shop-deleted consumer)
  - `webhook-delivery.e2e-spec.ts` — describe "Webhooks: delivery, ordering, retries and circuit breaker" (includes the worker and Lambda-handler entry points, duplicate queue message, poison message)
  - `webhook-ssrf.e2e-spec.ts` — describe "Webhooks: address guard at delivery"
  - `webhook-replay-log.e2e-spec.ts` — describe "Webhooks: delivery log, replay and test events"
  - `webhook-lifecycle.e2e-spec.ts` — describe "Webhooks: auto-disable, shop lifecycle and retention"
  - `webhook-contract.e2e-spec.ts` — describe "Webhooks: observability, problem details and contracts"
- The receiver is a real local HTTP(S) server controlled by the test (status script, hang, slow-drip, redirect, concurrency recorder); the resolver is an injected fake; the clock is frozen and advanced explicitly; the random source for jitter is injected. Those are the only fakes. Postgres, Redis, the delivery log store, the event bus and SQS stand-ins are real engines with migrations applied (`docker-compose.test.yaml`).
- Shops, users and memberships are seeded only through shared fixture helpers and the exported services of identity and tenancy; no spec injects `ShopModel`, `ShopMembershipModel` or any foreign model (D-7). Source events are published through the consumer entry points with schema-valid envelopes built from the `packages/contracts` event schemas; orders and products are not seeded in tables (the events carry the data).
- Every e2e test asserts the response body **and** the persisted state (endpoint and history rows, outbox rows, delivery-log items, queue messages, breaker state, receiver observations). Waiting uses `waitFor` on a condition, never a fixed sleep.
- Responses are parsed with the `packages/contracts` schemas (VII.6).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `signature.spec.ts` (extends the existing file: signing set at the expiry instant, verifier table), `webhook-url.spec.ts` (syntactic URL rules and normalisation), `endpoint-status.spec.ts` (state machine, `assertNever`), `retry-schedule.spec.ts` (delays, jitter bounds, `Retry-After` merge, exhaustion), `breaker.spec.ts` (state machine and open durations), `stock-low.spec.ts` (rule table), `webhook-event-mapper.spec.ts` (slice and mapping tables, with a `fast-check` property that the slices of an order partition its lines and never mention another shop), and `webhook-settings.spec.ts` (configuration validation). The address-classification table lives with the guard in S54 / S41 (`net` unit spec); this capability proves the wiring only.
- UI journey (Playwright) is owned by **W04** in `packages/web/e2e/developers.spec.ts`, happy path only, one journey "webhook endpoint lifecycle": an OWNER creates an endpoint (secret shown once with a copy action and gone after closing), sends a test event and sees a delivered attempt, rotates the secret (both secrets noted), fails a delivery on purpose and replays it. Journey **J02** (`packages/web/e2e/journeys/seller-to-first-sale.spec.ts`) asserts only that the order webhook arrives at a receiver after the sale. Neither repeats an edge case.
- Static gates (VII.1, IX.5, X.6): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict`; `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback tests that force the fault: AS-15 (limiter store down), AS-33 (queue down), AS-46 (log store down, redrive), AS-49 (breaker store down).
- Concurrency tests use `Promise.all` and assert exactly the allowed number succeed and the invariant holds, repeated at least 20 times in one test: AS-09, AS-11, AS-12, AS-20, AS-30, AS-44, AS-47, AS-57, AS-63.
- Async consumers (VII.4): the router (AS-30 duplicate, AS-31 invalid), the shop-deleted consumer (AS-66 duplicate and invalid), the delivery worker (AS-44 duplicate, AS-46 invalid).
- The k6 script `scripts/load-tests/webhooks-flood.test.js` (event flood to 500,000 endpoints with 10% slow receivers) proves SC-002 and SC-011. It is an ops artifact, not a row of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create endpoint, secret once | `webhook-endpoints.e2e-spec.ts` | W04 `developers.spec.ts` (create, secret shown once) | — |
| AS-02 validation classes | `webhook-endpoints.e2e-spec.ts` (table-driven, one case per class) | — | `webhook-url.spec.ts` (syntactic parse, length) |
| AS-03 address guard at save | `webhook-endpoints.e2e-spec.ts` (resolver fake, every listed target, create and patch) | — | `webhook-url.spec.ts` (scheme, user-info, port, IP-literal rules) |
| AS-04 payload version at create | `webhook-endpoints.e2e-spec.ts` | — | — |
| AS-05 list and pagination | `webhook-endpoints.e2e-spec.ts` (7 endpoints, cursor walk, bad cursor, limits) | — | — |
| AS-06 read one | `webhook-endpoints.e2e-spec.ts` | — | — |
| AS-07 update | `webhook-endpoints.e2e-spec.ts` (incl. blocked URL changes nothing, empty body) | — | — |
| AS-08 enable / disable, illegal transitions | `webhook-endpoints.e2e-spec.ts` (one wired `409` per illegal pair) | — | `endpoint-status.spec.ts` (transition table) |
| AS-09 concurrent enable | `webhook-endpoints.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-10 delete | `webhook-endpoints.e2e-spec.ts` | — | — |
| AS-11 endpoint limit, concurrent | `webhook-endpoints.e2e-spec.ts` (`Promise.all`, 18 → 20) | — | — |
| AS-12 duplicate URL | `webhook-endpoints.e2e-spec.ts` (sequential and `Promise.all`) | — | `webhook-url.spec.ts` (normalisation table) |
| AS-13 auth, role, tenant isolation | `webhook-endpoints.e2e-spec.ts` (every route × anonymous / STAFF / other shop / cross-shop ID) | — | — |
| AS-14 event-type catalogue | `webhook-endpoints.e2e-spec.ts` | — | — |
| AS-15 management rate limit, limiter down | `webhook-endpoints.e2e-spec.ts` (`429`, then fail-closed `503`) | — | — |
| AS-16 signature on a real delivery | `webhook-secrets.e2e-spec.ts` (receiver verifies raw body) | — | `signature.spec.ts` (HMAC over `t.body`) |
| AS-17 verifier rules | — | — | `signature.spec.ts` (table: tolerance edges 300/301 s, malformed headers, many `v1`) |
| AS-18 rotation | `webhook-secrets.e2e-spec.ts` | W04 `developers.spec.ts` (rotate) | — |
| AS-19 overlap boundary | `webhook-secrets.e2e-spec.ts` (frozen clock at expiry −1 ms and 0) | — | `signature.spec.ts` (active-secret selection at the instant) |
| AS-20 rotation state rules, concurrent | `webhook-secrets.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-21 overlap option | `webhook-secrets.e2e-spec.ts` | — | — |
| AS-22 secret hygiene | `webhook-secrets.e2e-spec.ts` (scan rows, cache, outbox, log items, captured logs, metrics) | — | — |
| AS-23 multi-shop order slice | `webhook-routing.e2e-spec.ts` | — | `webhook-event-mapper.spec.ts` (slice table + property) |
| AS-24 pinned versions | `webhook-routing.e2e-spec.ts` | — | — |
| AS-25 subscription filter | `webhook-routing.e2e-spec.ts` | — | — |
| AS-26 cancel and refund | `webhook-routing.e2e-spec.ts` | — | `webhook-event-mapper.spec.ts` (no amounts) |
| AS-27 product events | `webhook-routing.e2e-spec.ts` | — | `webhook-event-mapper.spec.ts` (mapping table) |
| AS-28 low stock | — | — | `stock-low.spec.ts` (rule table incl. UTC day boundary) |
| AS-29 sandbox and payouts | `webhook-routing.e2e-spec.ts` | — | `webhook-event-mapper.spec.ts` (payout mapping) |
| AS-30 duplicate source events | `webhook-routing.e2e-spec.ts` (twice, then `Promise.all`; VII.4) | — | — |
| AS-31 invalid source payload | `webhook-routing.e2e-spec.ts` (VII.4, dead-letter, valid event behind it) | — | — |
| AS-32 out-of-order source events | `webhook-routing.e2e-spec.ts` | — | — |
| AS-33 queue unavailable | `webhook-routing.e2e-spec.ts` (forced fault, gate 9) | — | — |
| AS-34 subscription freshness across instances | `webhook-routing.e2e-spec.ts` (two app instances) | — | — |
| AS-35 successful delivery | `webhook-delivery.e2e-spec.ts` | — | — |
| AS-36 order and single flight | `webhook-delivery.e2e-spec.ts` | — | — |
| AS-37 isolation | `webhook-delivery.e2e-spec.ts` | — | — |
| AS-38 timeouts and response cap | `webhook-delivery.e2e-spec.ts` (hang, slow-drip, 1 MiB body) | — | — |
| AS-39 response classification | `webhook-delivery.e2e-spec.ts` (`2xx` set, `301` not followed, failures, `Retry-After`) | — | — |
| AS-40 ordered lane then retry lane | `webhook-delivery.e2e-spec.ts` (11 attempts with the clock advanced) | — | — |
| AS-41 retry schedule | — | — | `retry-schedule.spec.ts` (table: delays, ±20% bounds at random 0 and 1, `Retry-After`, cap, exhaustion) |
| AS-42 recovery and ordering trade-off | `webhook-delivery.e2e-spec.ts` | — | — |
| AS-43 worker crash mid-attempt | `webhook-delivery.e2e-spec.ts` (kill after send, visibility timeout) | — | — |
| AS-44 duplicate and concurrent messages | `webhook-delivery.e2e-spec.ts` (`Promise.all`; VII.4) | — | — |
| AS-45 partial batch failure | `webhook-delivery.e2e-spec.ts` (Lambda handler entry point) | — | — |
| AS-46 poison message and redrive | `webhook-delivery.e2e-spec.ts` (VII.4, log store down, forced fault) | — | — |
| AS-47 circuit breaker | `webhook-delivery.e2e-spec.ts` (`Promise.all` probe) | — | — |
| AS-48 breaker state machine | — | — | `breaker.spec.ts` (table: durations 1, 2, 4, 8, 16, 30 min; states; `assertNever`) |
| AS-49 breaker store down | `webhook-delivery.e2e-spec.ts` (forced fault, gate 9) | — | — |
| AS-50 disable and delete take effect quickly | `webhook-delivery.e2e-spec.ts` | — | — |
| AS-51 DNS rebinding and pinned address | `webhook-ssrf.e2e-spec.ts` | — | — |
| AS-52 guard matrix at delivery | `webhook-ssrf.e2e-spec.ts` (table of resolver answers and redirect target) | — | — |
| AS-53 oversized body | `webhook-delivery.e2e-spec.ts` | — | — |
| AS-54 graceful shutdown | `webhook-delivery.e2e-spec.ts` | — | — |
| AS-55 failure window and auto-disable | `webhook-lifecycle.e2e-spec.ts` (frozen clock at −1 s and 0) | — | `endpoint-status.spec.ts` (window rule) |
| AS-56 a success resets the window | `webhook-lifecycle.e2e-spec.ts` | — | — |
| AS-57 sweep job | `webhook-lifecycle.e2e-spec.ts` (twice and `Promise.all`) | — | — |
| AS-58 alert hygiene | `webhook-lifecycle.e2e-spec.ts` (event, logs, metrics scan) | — | — |
| AS-59 re-enable after auto-disable | `webhook-lifecycle.e2e-spec.ts` | — | — |
| AS-60 attempt log | `webhook-replay-log.e2e-spec.ts` (cursor under concurrent insert, filters, 30-day cut) | W04 `developers.spec.ts` (delivered attempt visible) | — |
| AS-61 event detail | `webhook-replay-log.e2e-spec.ts` | — | — |
| AS-62 replay | `webhook-replay-log.e2e-spec.ts` | W04 `developers.spec.ts` (replay after failure) | — |
| AS-63 replay idempotency | `webhook-replay-log.e2e-spec.ts` (replay, in-flight via `Promise.all`, different body, missing, TTL) | — | — |
| AS-64 replay guards | `webhook-replay-log.e2e-spec.ts` | — | — |
| AS-65 test ping | `webhook-replay-log.e2e-spec.ts` (incl. `429`) | W04 `developers.spec.ts` (send test event) | — |
| AS-66 shop deleted | `webhook-routing.e2e-spec.ts` (VII.4: duplicate and invalid; batches of 1,000) | — | — |
| AS-67 retention | `webhook-lifecycle.e2e-spec.ts` (frozen clock at 30 d −1 s and 0) | — | — |
| AS-68 observability | `webhook-contract.e2e-spec.ts` | — | — |
| AS-69 contracts and errors | `webhook-contract.e2e-spec.ts` (every route parsed with its schema; forced `500`) | — | — |
| AS-70 boundaries, static gate | static gates above (`check:table-ownership --strict`, `check:boundaries`, ownership registry check) | — | — |
| AS-71 configuration | — | — | `webhook-settings.spec.ts` (table: production allowance, schedule order, jitter range, timeouts) |
