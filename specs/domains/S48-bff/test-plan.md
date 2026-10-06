# Test Plan: S48 — BFF composition (domain `composition`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (64 scenarios, AS-01 to AS-64). A dash means the layer does not test that scenario. Where a row names two layers, each proves a different part (stated in the cell); no part is proven twice.

- API e2e files live in `packages/backend/libs/composition/bff/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `BffAppModule` with the production global pipe, filter, prefix and interceptors and call it through `supertest`. The domain APIs (S05, S03, S34, S35, S38, S24, S25, S30, S19, S11, S21, S01, S02) are stubs at the network boundary (real HTTP servers on loopback) serving contract-valid fixtures parsed with the `packages/contracts` schemas (X.8.5); a stub records calls, headers, order, connection count and aborts, and can delay, fail or answer garbage. The session store, rate limiter and shaped-response cache run on a real Redis from `docker-compose.test.yaml`. The BFF has no database (X.8.1), so there is no Postgres or migration in this suite. Time is frozen with the shared clock helper and advanced explicitly; timing assertions compare against stub-recorded timestamps, not wall-clock sleeps.
- Only system-edge dependencies are faked: the domain APIs above (X.8.5) and time. The session store, cache, rate limiter, breaker and loaders are real. Every test asserts the response **and** the persisted effect (session records and their TTLs, cookie attributes, cache keys, rate-limit counters, stub call logs, metrics) and resets Redis and the stub logs first.
- Every e2e parses `200` bodies with the matching `packages/contracts` schema and error bodies with the problem schema (VII.6).
- No async consumers exist here (X.8.4), so the VII.4 pair does not apply.
- Unit specs sit beside the code, are table-driven (`it.each`) and exist only for pure logic (VII.5): the cost estimator, the breaker state machine, the CSRF token MAC, session lifetime math, cache-control parsing, ID de-duplication and chunking, and the concurrency gate. No unit tests for controllers, Redis glue or HTTP clients.
- UI journeys (Playwright, happy path only, owned by W01 and W02): `packages/web/tests/bff-session.spec.ts` (sign in through the BFF, navbar shows the user, sign out) and `packages/web/tests/product-page.spec.ts` (page renders its sections). No server edge case is re-tested in the browser (VII.7).
- Static gates (VII.1, AS-64): `tsc --noEmit` and ESLint for `packages/backend`, `packages/contracts`, `packages/web`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict`.
- Load proof of SC-008 is an operations artifact (`loadtest:product-page`, k6, one dependency slowed to 2 s), not an e2e row.
- Fallback paths (VII.9) each have a test that forces them: slow and failing sections (AS-12, AS-13), open breaker (AS-17), bulkhead (AS-18), cache miss path and coalescing (AS-19, AS-20), identity down (AS-56), session-store down (AS-61), store write failure after rotation (AS-57), persisted-query miss (AS-37).

Abbreviations for the e2e files (all under `libs/composition/bff/`):

| Key | File | Top-level `describe` |
|---|---|---|
| P | `bff.e2e-spec.ts` | `BFF product page composition` |
| G | `bff-graphql.e2e-spec.ts` | `BFF GraphQL` |
| S | `bff-session.e2e-spec.ts` | `BFF session handling` |
| B | `bff-boundary.e2e-spec.ts` | `BFF composition boundary` |

Unit files: `graphql/limits.spec.ts` (U1), `graphql/loader-batching.spec.ts` (U2), `circuit-breaker.spec.ts` (U3), `concurrency-gate.spec.ts` (U4), `shared-cache-policy.spec.ts` (U5), `session/csrf-token.spec.ts` (U6), `session/session-lifetime.spec.ts` (U7).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 full page, anonymous | P: all ten sections, schema parse, `private, no-store`, validated bodies unchanged | `product-page.spec.ts` (W02) renders product, shop, rails | — |
| AS-02 anonymous skips chat, no token, anon ID to flags | P: stub call log, no `Authorization`, chat not called, no error entry | — | — |
| AS-03 signed-in session forwards token, chat pass-through | P: token on flags and chat only, no `Cookie` upstream, `nextCursor` untouched | — | — |
| AS-04 hidden shop / no `shopId` | P: `shop: null`, no error, no shop call without `shopId` | — | — |
| AS-05 pickup needs location, bounds | P: skip, call with params, `400` for each invalid combination, no upstream call | — | — |
| AS-06 parallel start, dependent sections after product | P: stub timestamps: independent calls start with product, `shop`/`trending` after, total < sum | — | — |
| AS-07 unknown product `404`, outstanding calls aborted | P: problem body, stub sees aborts | — | — |
| AS-08 non-UUID ID | P: `400`, no calls | — | — |
| AS-09 product retry once | P: 503→200 (2 calls), 503×2 → `503` + `Retry-After` (2 calls), `404`/`400` no retry | — | — |
| AS-10 invalid product body | P: `502 upstream_invalid`, generic `detail`, log check | — | — |
| AS-11 upstream `401` → `401` | P: bearer request, chat stub `401`, others aborted | — | — |
| AS-12 slow optional section | P: 500 ms recommendations, `errors` entry, timing bound, abort seen | — | — |
| AS-13 failure classes per section | P: `it.each` over 10 sections × 5 failures, closed code set, no leakage | — | — |
| AS-14 one failure isolated, all fail | P: byte-compare other sections, all-optional-fail `200` | — | — |
| AS-15 trending/recommendations pass-through | P: unchanged body, empty `items`, slow/`503`/`429`/invalid | — | — |
| AS-16 overall deadline | P: product 700 ms + shop 600 ms → `BUDGET_EXCEEDED`, total ≤ 1,100 ms; product > 800 ms → `503` | — | — |
| AS-17 circuit breaker | P: 5 failures open it, call skipped, probe after 10 s (frozen clock), re-open and close | — | U3: state machine table (closed/open/half-open, counters, window) |
| AS-18 bulkhead and per-request bound | P: 100 in flight from a held stub → `UPSTREAM_OVERLOADED`, product `503 overloaded`, ≤ 12 per request observed | — | U4: gate admits/rejects table |
| AS-19 shared cache rules | P: `s-maxage=5` hit/expire, `private`/`no-store` not cached, personal never cached, user A vs B vs anonymous, 30 s ceiling | — | U5: `Cache-Control` parsing table |
| AS-20 coalescing | P: 50 parallel requests → one call per public upstream, flags/chat per visitor | — | — |
| AS-21 header hygiene, redirects | P: forged identity headers dropped, anon ID rules, `Authorization` only where declared, `302` not followed | — | — |
| AS-22 page rate limit | P: 301st → `429` + `Retry-After`, Redis counter, other principal unaffected | — | — |
| AS-23 observability | P: `Server-Timing`, metrics for each outcome, log line fields, no secrets | — | — |
| AS-24 keep-alive reuse | P: connection count per stub host ≤ 10 over 30 requests | — | — |
| AS-25 20 products → 2 calls | G: call counts, order | — | — |
| AS-26 duplicates and hidden | G: batch carries unique IDs, result `[A, null, A, C]` | — | U2: de-dup/order/length table (property: output length = input length) |
| AS-27 chunking at 100 | G: 150 distinct IDs → 100 + 50 | — | U2: chunking table |
| AS-28 per-request isolation | G: two principals in parallel, own credentials, repeat request repeats calls | — | — |
| AS-29 batch failure isolation | G: `503` product batch, `path`, `extensions.code`, sibling fields intact, once per path | — | — |
| AS-30 recommendations timeout, batched hydration | G: `path: ["product","recommendations"]`, one product batch for recommended IDs | — | — |
| AS-31 depth limit | G: `400 QUERY_TOO_DEEP`, zero upstream calls | — | U1: depth table |
| AS-32 cost limit (literal, variable, fragments, boundary) | G: literal and variable rejected before any call | — | U1: cost table (aliases, fragments, cycles, exactly 2,000, recommendations = 8, variable lists) |
| AS-33 root fields, array batching, size, media type | G: `400`/`400`/`413`/`415` | — | — |
| AS-34 input bounds | G: 51 IDs, `[]`, non-UUID, `first` 51 | — | — |
| AS-35 operation deadline | G: slow stub, `BUDGET_EXCEEDED`, aborts, ≤ 2,100 ms | — | — |
| AS-36 cost rate limit | G: budget exhausted → `429` + headers, rejected query charged 1, other principal free | — | — |
| AS-37 trusted documents | G: known, unknown, text-only, mismatch, dev mode | — | — |
| AS-38 persisted `GET` | G: anonymous cacheable headers, credentialed `private, no-store`, raw `GET` `400` | — | — |
| AS-39 allowlist integrity at startup | B: boot with a bad hash and with an invalid document → startup rejects, message names entry | — | — |
| AS-40 introspection and read-only | G: production config vs non-production, mutation/subscription rejected | — | — |
| AS-41 money type and schema snapshot | G: `priceMinor` string, `currency`, no float; snapshot comparison fails on drift | — | — |
| AS-42 GraphQL credentials | G: token only on identity fields; cookie `POST` without CSRF / bad origin → `403`, zero calls | — | — |
| AS-43 login | S: cookies and attributes, no token anywhere, record key = hash, tokens encrypted, S01 called once | `bff-session.spec.ts` (W01): sign in, navbar user, sign out | — |
| AS-44 login origin check | S: `403`, no cookie, no S01 call | — | — |
| AS-45 login failures relayed, validation | S: `401` identical for unknown address, `429`, `503`, `400`/`413`/`415` before upstream | — | — |
| AS-46 client address forwarded | S: stub sees `X-Forwarded-For`, untrusted header ignored | — | — |
| AS-47 fixation | S: old cookie unknown after relogin, new ID, old identity session revoked, revoke failure tolerated | — | — |
| AS-48 MFA flow | S: `mfaRequired`, pending cookie, token not leaked, verify → active session | — | — |
| AS-49 MFA illegal states | S: `409` three cases, wrong code keeps pending, spent challenge deletes it | — | — |
| AS-50 concurrent MFA verify | S: `Promise.all`, one `200` one `409`, one session record | — | — |
| AS-51 `GET /session` | S: `200`, `401` without cookie, random value, stored hash as cookie | — | — |
| AS-52 idle and absolute expiry | S: frozen clock, record deleted, cookie cleared, public read anonymous, write at most once a minute | — | U7: expiry/sliding table |
| AS-53 proactive refresh | S: token near expiry refreshed once, new token forwarded, no refresh with > 30 s left | — | — |
| AS-54 single flight across instances | S: two app instances, 20 requests in parallel, exactly one refresh call | — | — |
| AS-55 refresh rejected | S: `401` from S01 → session ended, cookies cleared, no retry | — | — |
| AS-56 identity down on refresh | S: valid token proceeds, expired → `503`, session kept, one attempt | — | — |
| AS-57 store write failure after rotation | S: Redis failure injected, retry success, 3 failures → session ended, `503` | — | — |
| AS-58 logout | S: no CSRF `403`, valid `204`, identity down `204`, replay `204` with no call | — | — |
| AS-59 CSRF rules | S: missing / mismatched / other-session token `403`, `GET` and bearer exempt | — | U6: MAC bind/verify table (constant-time compare, tamper cases) |
| AS-60 cookie + bearer | S: `400 ambiguous_credentials` on page, GraphQL, session | — | — |
| AS-61 session store down | S: anonymous served, cookie request `503`, readiness unaffected | — | — |
| AS-62 user isolation | S: A and B interleaved, forged/logged-out cookies | — | — |
| AS-63 token only to configured origin, startup validation | S: redirect and misconfigured section refused; B: startup fails without upstream URL | — | — |
| AS-64 composition boundary | B: booted app has no DB/queue/event provider, no request-scoped provider; static gates `check:boundaries`, `check:table-ownership --strict` | — | — |
