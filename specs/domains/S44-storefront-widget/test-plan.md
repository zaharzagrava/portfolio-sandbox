# Test Plan: S44 — Embeddable storefront widget (domain `developer-platform`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (54 rows), each proven at the lowest layer that can prove it. A dash means that layer does not test the scenario. Where both a unit and an e2e entry appear, the unit proves the pure rule table and the e2e proves one wired case through the real modules, never the table again.

## Layout and rules

- API e2e files live in `packages/backend/libs/domains/developer-platform/`, boot the real `WidgetModule` and `WidgetProjectorModule` (plus the identity, tenancy, catalog and rate-limit modules they import) with the production prefix (`/api`), pipe, filter, helmet, CORS and interceptors, and call through `supertest`. The old `widget.e2e-spec.ts` is split into the files below and deleted.
  - `widget-sites.e2e-spec.ts` — describe "Widget: site management (dashboard)"
  - `widget-config.e2e-spec.ts` — describe "Widget: origin binding, config and CORS"
  - `widget-identity.e2e-spec.ts` — describe "Widget: identity hand-off and widget session"
  - `widget-embed.e2e-spec.ts` — describe "Widget: embed document and framing policy"
  - `widget-kill-lifecycle.e2e-spec.ts` — describe "Widget: kill switch and shop lifecycle (consumers)" (includes the VII.4 duplicate-delivery and invalid-payload tests of the three consumers)
  - `widget-contract.e2e-spec.ts` — describe "Widget: events, observability and contracts"
- Only system-edge dependencies are faked: the clock is frozen and advanced explicitly; the product lookup's failure is forced by making S05's service raise through a test provider override at the module boundary only for AS-21 (the single fault-injection row); the single-use store and the limiter store failures (AS-22, AS-27) are forced by pointing the real client at a stopped Redis stand-in. Postgres, Redis, the outbox and the consumer runtime are real engines with migrations applied (`docker-compose.test.yaml`).
- Shops, users and memberships are seeded only through shared fixture helpers and the exported services of identity and tenancy; products through catalog's exported commands or the shared seeds helper; no spec injects `ShopModel`, `ProductModel` or any foreign model (D-7). Shop events are published through the consumer entry points with schema-valid envelopes built from the `packages/contracts` event schemas.
- Hand-off tokens are signed by the test helper `signWidgetHandoff(secret, claims)` (test code only), so the specs do not call production signing code.
- Every e2e test asserts the response body **and** the persisted state (site and history rows, sealed secret, outbox rows, single-use markers, cache effects, consumer receipts). Waiting uses `waitFor` on a condition, never a fixed sleep. Responses are parsed with the `packages/contracts` schemas (VII.6).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `origin.spec.ts` (normalisation and matcher), `handoff-claims.spec.ts` (claims policy with an injected clock), `theme.spec.ts` (allowlist table), `frame-policy.spec.ts` (frame-ancestors builder and CSP assembly), `shop-copy.spec.ts` (version-guard decision table used by AS-42/AS-43), and in `packages/edge-be/src/widget-loader.spec.ts` the loader script under jsdom with a fake `fetch` and fake windows (component-style test of the generated script; the only place `postMessage` filtering can be proven without a browser).
- UI journey (Playwright, happy path only): **W07** owns `packages/web/e2e/widget.spec.ts` ("Embedded storefront widget": a fixture host page on a registered origin, a visitor clicks the button, the iframe opens, the host supplies a hand-off token, the checkout screen shows the customer, closing removes the iframe); **W04** owns the "widget site lifecycle" journey in `packages/web/e2e/developers.spec.ts` (an OWNER creates a site, sees the secret once, switches the widget off and on). Neither repeats an edge case.
- Static gates (VII.1, IX.5, X.6): `tsc --noEmit` and ESLint for `packages/backend`, `packages/edge-be` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict`; `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback tests that force the fault: AS-21 (product lookup down: stale copy and `503`), AS-22 (limiter store down: config open, identify closed), AS-27 (single-use store down).
- Concurrency tests use `Promise.all` and assert exactly the allowed number succeed and the invariant holds, repeated at least 20 times in one test: AS-05, AS-07, AS-11, AS-26, AS-40.
- Async consumers (VII.4): shop-updated, status-changed and deleted consumers (AS-42 duplicate and out-of-order, AS-43 out-of-order, AS-44 duplicate, AS-45 invalid payload for all three).
- The k6 script `scripts/load-tests/widget-config.test.js` (50k RPS config flood behind a CDN stand-in for 10,000 sites) proves SC-007. It is an ops artifact, not a row of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create site, secret once, sealed at rest | `widget-sites.e2e-spec.ts` | W04 `developers.spec.ts` (create, secret shown once) | — |
| AS-02 origin rules table | `widget-sites.e2e-spec.ts` (one wired `422 origin_invalid` case) | — | `domain/origin.spec.ts` (normalise/reject table) |
| AS-03 validation failures, duplicate origins collapse | `widget-sites.e2e-spec.ts` | — | — |
| AS-04 theme allowlist | `widget-sites.e2e-spec.ts` (one wired accept, one wired reject) | — | `domain/theme.spec.ts` (value-format table) |
| AS-05 site limit, concurrent creates | `widget-sites.e2e-spec.ts` | — | — |
| AS-06 list and read, keyset paging | `widget-sites.e2e-spec.ts` | — | — |
| AS-07 update, optimistic version, concurrent updates | `widget-sites.e2e-spec.ts` | — | — |
| AS-08 featured products belong to the shop | `widget-sites.e2e-spec.ts` | — | — |
| AS-09 permission matrix, IDOR, 401 | `widget-sites.e2e-spec.ts` | — | — |
| AS-10 secret rotation with overlap | `widget-sites.e2e-spec.ts` | — | — |
| AS-11 rotation conflicts, early expiry, concurrent rotations | `widget-sites.e2e-spec.ts` | — | — |
| AS-12 delete site, effects on every instance | `widget-sites.e2e-spec.ts` | — | — |
| AS-13 dashboard CSRF (cookie vs bearer) | `widget-sites.e2e-spec.ts` | — | — |
| AS-14 config body, headers, one R1 batch | `widget-config.e2e-spec.ts` | W07 `widget.spec.ts` (button rendered from config) | — |
| AS-15 origin matching table | `widget-config.e2e-spec.ts` (three wired mismatches: scheme, port, suffix look-alike) | — | `domain/origin.spec.ts` (matcher table) |
| AS-16 refusals leak nothing, order of checks | `widget-config.e2e-spec.ts` | — | — |
| AS-17 unknown and malformed keys | `widget-config.e2e-spec.ts` | — | — |
| AS-18 per-site preflight | `widget-config.e2e-spec.ts` | — | — |
| AS-19 product shaping and order | `widget-config.e2e-spec.ts` | — | — |
| AS-20 changes visible on every instance, creation after negative lookup | `widget-config.e2e-spec.ts` (two app instances over one Redis and one database) | — | — |
| AS-21 stale-on-error and 503 (fallback path) | `widget-config.e2e-spec.ts` | — | — |
| AS-22 rate limits and fail modes (fallback path) | `widget-config.e2e-spec.ts` | — | — |
| AS-23 identify exchange | `widget-identity.e2e-spec.ts` | W07 `widget.spec.ts` (customer recognised in checkout) | — |
| AS-24 claims policy table | `widget-identity.e2e-spec.ts` (two wired rejections: too long, missing jti) | — | `domain/handoff-claims.spec.ts` (full table, injected clock) |
| AS-25 forgeries (alg none, confusion, wrong secret, foreign issuer) | `widget-identity.e2e-spec.ts` | — | — |
| AS-26 replay and concurrent replay | `widget-identity.e2e-spec.ts` | — | — |
| AS-27 single-use store down, fail closed (fallback path) | `widget-identity.e2e-spec.ts` | — | — |
| AS-28 secret overlap boundary | `widget-identity.e2e-spec.ts` | — | — |
| AS-29 no account linking | `widget-identity.e2e-spec.ts` | — | — |
| AS-30 order of checks on identify | `widget-identity.e2e-spec.ts` | — | — |
| AS-31 no ambient credentials, JSON only, size limits | `widget-identity.e2e-spec.ts` | — | — |
| AS-32 session endpoint and verifier | `widget-identity.e2e-spec.ts` | — | — |
| AS-33 token isolation across verifiers | `widget-identity.e2e-spec.ts` | — | — |
| AS-34 embed document and strict CSP, nonce uniqueness | `widget-embed.e2e-spec.ts` | — | `domain/frame-policy.spec.ts` (CSP assembly: required directives present, forbidden tokens absent) |
| AS-35 frame-ancestors equals the site's list | `widget-embed.e2e-spec.ts` | — | — |
| AS-36 every other response refuses framing | `widget-embed.e2e-spec.ts` (route table) | — | — |
| AS-37 embed refusals, no reflection | `widget-embed.e2e-spec.ts` | — | — |
| AS-38 policy builder | — | — | `domain/frame-policy.spec.ts` (origin-list builder table, throws on bad input) |
| AS-39 kill switch off, effects, history | `widget-kill-lifecycle.e2e-spec.ts` | W04 `developers.spec.ts` (switch off and on) | — |
| AS-40 idempotent and race-safe switching | `widget-kill-lifecycle.e2e-spec.ts` | — | — |
| AS-41 restore, malformed body | `widget-kill-lifecycle.e2e-spec.ts` | — | — |
| AS-42 rename, out-of-order and duplicate events | `widget-kill-lifecycle.e2e-spec.ts` | — | `domain/shop-copy.spec.ts` (version-guard table) |
| AS-43 suspension disables sites, reverse order | `widget-kill-lifecycle.e2e-spec.ts` | — | — |
| AS-44 shop deleted, duplicate | `widget-kill-lifecycle.e2e-spec.ts` | — | — |
| AS-45 invalid event payloads, duplicate delivery | `widget-kill-lifecycle.e2e-spec.ts` | — | — |
| AS-46 creation seeds the shop copy | `widget-kill-lifecycle.e2e-spec.ts` | — | — |
| AS-47 loader contract (size, sinks, global, headers) | — | — | `packages/edge-be/src/widget-loader.spec.ts` (script string checks, plus the worker's `fetch` handler for `/widget/v1/loader.js` headers) |
| AS-48 postMessage origin, source and type filtering | — | — | `packages/edge-be/src/widget-loader.spec.ts` |
| AS-49 failure isolation of the loader | — | — | `packages/edge-be/src/widget-loader.spec.ts` |
| AS-50 loader journey in a real browser | — | W07 `packages/web/e2e/widget.spec.ts` | — |
| AS-51 events in the outbox, no event on no-op | `widget-contract.e2e-spec.ts` | — | — |
| AS-52 metrics and no secrets in logs | `widget-contract.e2e-spec.ts` | — | — |
| AS-53 problem+json and contract schemas on every route | `widget-contract.e2e-spec.ts` | — | — |
| AS-54 static gates and registry | — (CI commands listed above; registry entries asserted by `check:table-ownership --strict`) | — | — |
