# Success criteria no automated test proves yet

Every row is a claim the specs make that has **not** been run. Do not state any of these as verified (README, resume,
interviews) until its status says so. The implementation loop appends here (rule 2 in `extra_context` of
`scripts/sdd/implement-specs.sh`); a later load-proof task is meant to run them, e.g. on the VPS runner.

| Spec | Criterion | How to run it | Status |
| --- | --- | --- | --- |
| S54 | SC-002: 20 rolling restarts under steady load drop no accepted request | `specs/domains/S54-platform-toolkit/quickstart.md`, "Ops artifacts" (restart loop) | not run |
| S54 | SC-003: at 2x capacity, admitted p99 under 300 ms, refusals are 503 with Retry-After, probes never refused | same file (k6 at 2x capacity) | not run |
| S54 | SC-004: a 60 s database outage keeps readiness 200 and returns fast 503 for database routes | same file (outage drill) | not run |
| S54 | SC-008: context and logging overhead under 0.5 ms p99 per request | same file (overhead benchmark) | not run |
| S54 | SC-001: 10 000 responses of every error kind parse as problem+json with 0 leaks | `specs/domains/S54-platform-toolkit/quickstart.md`, "Ops artifacts" (error sample) | not run |
| S54 | SC-006: 1 000 parallel requests with one Idempotency-Key give exactly one side effect | same file (parallel idempotency) | not run |
| S54 | SC-010: a new capability adds a domain error, probe check, shutdown task, outbound client and idempotent route using only contract names | same file (throwaway capability) | not run |
| S53 | SC-001: 10 000 randomized commit/rollback transactions with relay crashes and broker outages lose no committed event and emit none for a rollback | `specs/domains/S53-events-projections/quickstart.md`, "Ops artifacts" (randomized crash driver) | not run |
| S53 | SC-004: with `minVersion`, 99% of reads see the write within 500 ms and 100% within 2.5 s | same file (read-your-writes latency run) | not run |
| S53 | SC-005: projection lag p99 under 2 s at 1, 2 and 4 instances on 100 000 events | same file (F-05 load script) | not run |
| S53 | SC-006: 100 000-event shadow rebuild with zero failed live reads and promotion refused until caught up | same file (rebuild drill) | not run |
| S53 | AS-21 (not an SC): the CDC relay emits the same topic, key, value and headers as the poller | same file (`S53_CDC=1` outbox-cdc spec with the `cdc` profile) | not run |
| S49 | SC-002: doubling workers 1 to 2 to 4 roughly halves no-op drain time (within 30% of linear), zero re-executions | `pnpm --dir packages/backend loadtest:jobs` at 1, 2, 4 workers (VPS runner) | not run |
| S49 | SC-006: a schedule fire materialises within 2 s of due and a delayed job starts within 1 s of `runAt` under normal load | `loadtest:jobs` with 1 s `runAt` jobs and a 10 s schedule; read `job_queue_lag_seconds` | not run |
| S49 | SC-007: queue lag visible within 10 s of becoming non-zero | scrape `/metrics` while enqueuing past-due jobs with workers stopped | not run |
| S49 | AS-88 / AS-89 at full scale (200,000 jobs, 5,000 cycles); CI runs a reduced size | `S49_PLAN_ROWS=200000 S49_HOT_CYCLES=5000 scripts/sdd/test-spec.sh libs/infrastructure/jobs/jobs-retention.e2e-spec.ts` on the runner | not run |
| S52 | SC-004: 10,000 repeated lookups of one unknown key cause 1 source read | loop 10,000 `getOrLoad` calls with `negativeTtlMs` against the test Redis; count loader calls | not run |
| S52 | SC-005: no more than 5 % of 1,000 same-time keys share one expiry second | store 1,000 keys, read `PTTL` of each, bucket by second | not run |
| S52 | SC-008: after 1,000,000 distinct reads the in-process structures stay within their limits | read 1,000,000 distinct keys; sample `cache_l1_entries` and heap | not run |
| S52 | SC-009: cache layer adds under 5 ms p99 over the store round trip | benchmark `getOrLoad` hits against a bare `GET` on the VPS runner | not run |
| S50 | SC-001 (4 instances): 0 overshoot at 2x the limit through 1, 2 and 4 instances (e2e covers two) | `specs/domains/S50-rate-limiter/quickstart.md`, "Ops artifacts" (`pnpm loadtest:ratelimit`) | not run |
| S50 | SC-002: lease-served decision under 1 ms p99; 100,000 decisions/s with at most 10% store calls | same file (k6/benchmark on the VPS runner) | not run |
| S50 | SC-003: after three store failures no request waits for a timeout; no limiter-caused 5xx on fail-open routes under load | same file (stop Redis under k6 load) | not run |
| S50 | SC-007: every route of apps/core is limited, defaulted or exempt | same file (boot-time route listing) | not run |
| S01 | SC-001 (timing): register then log in in under 30 seconds | `specs/domains/S01-auth-sessions/quickstart.md`, "Ops artifacts" (W01 journey with a stopwatch assertion) | not run |
| S01 | SC-005 (edge half): zero identity calls per request at the edge and zero rejected valid tokens across a key rotation | same file (rotate keys under k6 through `packages/edge-be`) | not run |
| S01 | SC-006: 2,000 logins/s fleet-wide, p99 login < 300 ms, refresh < 50 ms, overload shed with 503 + Retry-After | same file (k6 login storm on staging) | not run |
| S01 | SC-008 (browser half): no access or refresh token in script-readable storage in the cookie flow | same file (W01 Playwright journey AS-86 inspecting storage and `document.cookie`) | not run |
| S02 | SC-004 (latency half): 95 % of Google sign-ins complete within 3 s of approval | `specs/domains/S02-mfa-oidc/quickstart.md`, "Ops artifacts" (200 sign-ins on staging, p95 from callback to rendered page) | not run |
| S02 | SC-007: a member enables the authenticator app and saves recovery codes in under 2 minutes | same file (W01 journey AS-65 with a stopwatch assertion) | not run |
| S02 | SC-008 (browser half): no token, code, secret, state, nonce or verifier in script-readable browser storage across the S02 flows | same file (W01 Playwright journeys AS-65/AS-66 inspecting storage, `document.cookie`, URL history) | not run |
| S03 | SC-003: 200 randomized pairs of simultaneous owner demotions/removals keep at least one owner and exactly one success per pair (the e2e runs 20 repetitions) | `specs/domains/S03-shops-rbac/quickstart.md`, "Ops artifacts" (`TENANCY_RACE_PAIRS=200` run of the AS-23 test) | not run |
| S03 | SC-005: create a shop and have a colleague join through an invite in under 3 minutes of interaction | same file (W04 journey `shop-team.spec.ts` timed, plus a manual staging run) | not run |
| S03 | SC-006 (latency half): while a dedicated cell is saturated, other shops' requests stay within normal latency | same file (k6 with the `dedicated-1` pool held at capacity, deferred until SD-07 endpoints exist) | not run |
| S03 | SC-006 (first half): moving a shop to a dedicated cell needs zero changes in any other domain's code or queries | same file ("Ops artifacts"; move a shop and run another domain's existing query unchanged) | not run |
| S03 | SC-009: `check:table-ownership --strict` reports no cross-owner access to tenancy tables | same file ("Ops artifacts"; run `check:table-ownership --strict`, red until the consumers in gaps.md section C migrate) | not run |
| S05 | SC-004: 99% of product pages show a new price within 5 s and 100% within 6 minutes even if the notification is lost | `specs/domains/S05-products/quickstart.md`, "Ops artifacts" (price-change propagation script on a deployed stack) | not run |
| S05 | SC-007: after 10,000 views of one product at most one count write per 10 s for it, and the stored count equals the views served | same file (k6 10,000 reads plus `pg_stat_statements` count) | not run |
| S05 | SC-008: a seller lists a new product and sees it in the inventory in under 2 minutes of interaction | same file (W04 inventory walk-through, timed, once the screen exists) | not run |
| S05 | SC-009: `check:table-ownership --strict` reports 0 findings for `catalog` and no query against `Product` from any other domain | same file (`check:table-ownership --strict`; the second half is red until the consumers in gaps.md section C migrate) | not run |
| S10 | SC-001: 100% of 50 repeated races of 200 buyers for 50 units end with 50 accepted and no oversell (the e2e runs the race 5 times) | `specs/domains/S10-cart-checkout/quickstart.md`, "Ops artifacts" (50-run loop) | not run |
| S10 | SC-003: 99% of checkouts answer in under 800 ms with 200 buyers at once | same file (k6, 200 virtual users) | not run |
| S10 | SC-004 (latency part): 99% of cart operations finish in under 50 ms (no-relational-access half is tested by AS-01) | same file (k6 on `GET /cart` and `PUT /cart/items/:id`) | not run |
| S10 | SC-005 (latency part): 99% of genuine webhooks are acknowledged in under 1 s (forgery and duplicate halves are tested) | same file (k6 with signed events) | not run |
| S10 | SC-010: `check:table-ownership --strict` reports 0 cross-domain accesses for `orders` (the `order-export.service.ts` `Product` join stays until S12) | same file (`check:table-ownership --strict`; green after S12 lands) | not run |
| S13 | SC-001: 0 double charges in 200 repeated runs of 5 simultaneous payment requests (the e2e runs 5 simultaneous once and the two-key race 50 times) | `specs/domains/S13-payment-intents/quickstart.md`, "Ops artifacts" (200-run loop of the AS-05 and AS-06 tests) | not run |
| S13 | SC-002: 99% of payment requests and reads answer in under 300 ms over a sustained run with the provider down (AS-37 proves one request and one read) | same file (k6, provider double stopped, 5 minutes) | not run |
| S13 | SC-006 (timing part): a refund completes within 5 minutes of the command with a healthy provider (exactly-once is tested by AS-49 to AS-51) | same file (100 refund commands against the sandbox provider) | not run |
| S13 | SC-009: the buyer sees the final result within 5 s of the provider's answer on the real stack (relay, hub, SSE) | same file (SSE and polling probe against the sandbox provider) | not run |
| S13 | SC-010 (log part): 0 secrets or card data in a 10,000-line log sample of the full flows (AS-63 searches sentinels in the flows it runs) | same file (log capture loop and grep) | not run |
| S13 | SC-010 (ownership part): `check:table-ownership --strict` reports 0 findings for `payments` (3 remain in S14/S15 files: `ledger-entry.model.ts` User, `finance-worker.module.ts` and `payout.jobs.ts` Shop) | same file (`check:table-ownership --strict`; green after S14 and S15 land) | not run |
| S51 | SC-001: 50,000 idle connections, 5,000 events/s; at 5,000 connections x 10 events/s p99 under 500 ms, no healthy-viewer loss | `specs/domains/S51-realtime-push/quickstart.md`, "Ops artifacts" (`pnpm loadtest:sse`) | not run |
| S51 | SC-002 (100 repetitions): 100 reconnects lose and duplicate nothing; beyond the window resync 100% (AS-14 proves one) | same file (REPLAY scenario loop) | not run |
| S51 | SC-005 (10,000 cycles): memory returns to baseline after 10,000 connect/close cycles (AS-42 runs 500) | same file (k6 cycle case, heap comparison) | not run |
| S51 | SC-007: restarting every instance reconnects all viewers within 10 s | same file (k6 reconnect-storm case) | not run |
| S51 | SC-008 (under load): publisher latency under hub outage at most +1 s (AS-32 proves one attempt, 1 s) | same file (outage drill under load) | not run |
| S32 | SC-001: p95 under 300 ms at 100,000 searches/s over 50 M products | `specs/domains/S32-product-search/quickstart.md`, "Ops artifacts" (k6 `loadtest:search`) | not run |
| S32 | SC-002: change visible in 10 s (p95) / 60 s (p99) at 5,000 product changes/s | same file (event-stream lag run) | not run |
| S32 | SC-003 (load part): reindex under full load causes zero failed searches, rollback under one minute (AS-40 proves 50 searches/s) | same file (reindex during k6 load) | not run |
| S32 | SC-006: zero hidden products in 10,000 searches against a polluted index | same file (polluted-index replay) | not run |
| S32 | SC-010: at least 95% of a curated typo set finds the intended product | same file (relevance harness) | not run |
| S33 | SC-001: 99% of keystrokes answered within 100 ms at 50,000 requests/s behind the edge cache | `specs/domains/S33-autocomplete/quickstart.md`, "Ops artifacts" (`loadtest:suggest`) | not run |
| S33 | SC-003: a query reaching 5 distinct searchers is suggested within 65 minutes | same file (deployed worker and node, hourly build plus poll) | not run |
| S33 | SC-007: at least 18 of 20 single-typo searches show a correct suggestion | same file (typo fixture against the real engine, needs S32 fuzzy method) | not run |
| S33 | SC-008: 200,000-query index within 400 MB per serving node (AS-54 proves a scaled bound) | same file (load a 200k snapshot, compare RSS) | not run |
