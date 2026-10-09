# Gaps: current code vs S50 spec

Files in scope (all under `packages/backend/libs/infrastructure/rate-limit/` unless noted): `rate-limit.types.ts`, `rate-limit.decorator.ts`, `rate-limit.interceptor.ts`, `rate-limiter.service.ts`, `lua.ts`, `in-memory-token-bucket.ts`, `redis-throttler.storage.ts`, `rate-limit.module.ts`, `rate-limit.e2e-spec.ts`; `packages/edge-be/src/index.ts`; the throttler wiring in `apps/core`, `apps/sse-gateway`, `libs/domains/identity/api/decorators/firewall.decorator.ts`, `test/utils/global-modules.ts`; the callers listed below.

The code is a good draft of the engine: atomic token-bucket and concurrency scripts on the store clock, lease slices with a single-flight refill, an in-memory fallback, a three-strike breaker, hashed e-mail subjects, a decorator that runs as an interceptor after the guards. The gaps are the HTTP contract, the sliding window's clock, failure-only counting, cost and penalties, the central domain-named policy table, the second limiter, and tests that mock the thing they test.

## Debt register and ownership check

| Source | State | What S50 does |
|---|---|---|
| **D-17** (X.5): file cycle rate-limit decorator ↔ interceptor | **open, names S50** | `rate-limit.decorator.ts:3` imports the interceptor and `rate-limit.interceptor.ts:9` imports `RATE_LIMIT_METADATA` from the decorator. Move the metadata key to its own file (`rate-limit.metadata.ts`) imported by both. Check: `pnpm --dir packages/backend check:boundaries` shows no rate-limit cycle warning. |
| D-1, D-2, D-3 (infrastructure imports domain/legacy code, generic types, topics) | resolved (Phase 3) | The lib's production code has 0 `@app/domains/*` imports (grep). The one remaining import is a **test** (`rate-limit.e2e-spec.ts:8` imports `AuthApiModule` from identity): drop it (G-38). |
| D-14 (LLM port in `assistant/infra/llm`), D-16 (Elasticsearch product adapter) | open, name `infrastructure` | belong to S46 and S32. Nothing here. |
| D-6, D-8 | open, apply to domains and barrels | S50 only adds a public entry (G-21) so domains stop deep-importing `@app/infrastructure/rate-limit/rate-limiter.service`. |
| D-7 (domains import other domains' `*Model`) | open for other domains | The lib registers no model and no domain imports one of its. No replacement needed. |
| D-12 (cross-domain raw SQL) | open for other domains | The lib issues no SQL. It reads identity only from the request object that S01's guards fill (`request.user.id`, `request.apiKey.{id,shopId}`), which is not a data read: no R1/R2/R3 is needed. A plan-tiered limit ("different tiers per plan", notes §3 Dimensions) would be an **R1** call to S18's entitlement service by the *declaring* domain, never a query here; it is out of this spec. |
| `pnpm --dir packages/backend check:table-ownership` | **not run**: the command needed approval in this unattended session (also `check:boundaries`). By grep, `rate-limit/` has no `sequelize`, `InjectModel`, `.query(` or `literal(`, no table, and no `db/ownership.ts` entry is required: its state lives under the store prefixes `rl:` and `throttle:`. The expected output for this domain is **0 findings**. | The implementation agent runs it, confirms 0 lines for `infrastructure/rate-limit`, and pastes the result in the PR. |

## Gaps by area

### Policy registry (FR-050 to FR-053, AS-69 to AS-72)

- **G-01** `rate-limit.types.ts:37-65`: one central `RATE_LIMIT_POLICIES` table with the names of checkout, auctions, chat, discussions, live, notifications, LLM and imports (X.3: no domain names in infrastructure). Replace with `definePolicies(owner, table)` (typed with `satisfies`, P0113), `RateLimitModule.forFeature(table)` and a runtime registry that validates the whole table at startup, rejects duplicates naming both modules and rejects decorator references to undeclared names. Keep only `default.read` and `default.write` here. Name type: a union assembled by module augmentation so `@RateLimit('x')` and `check('x', …)` fail to compile for undeclared names (AS-72).
- **G-02** No startup validation of a policy (limit, window, fraction, failMode required, name grammar, key source, count mode): add the pure validator (AS-69) and call it from the registry. `failMode` is currently required by type only.
- **G-03** `rate-limit.module.ts:5-11`: a plain `@Global()` module with no `forRoot`/`forFeature`. Add both, register the default interceptor in `forRoot`, and export only the public surface from a new `index.ts` (G-21).

### HTTP contract (FR-025 to FR-034, AS-37 to AS-47, AS-82)

- **G-04** `rate-limit.interceptor.ts:75-81`: headers are `RateLimit-Policy: "<limit>;w=<s>"` plus `RateLimit-Limit`, `-Remaining`, `-Reset`. Emit `RateLimit-Policy: "<name>";q=<limit>;w=<s>` and `RateLimit: "<name>";r=<remaining>;t=<s>`, one item per non-concurrency policy, with the formatting rules of AS-82 (pure formatter, unit test). Today only the "tightest" decision is reported, labelled with `policies[0]` (`:70`), which names the wrong policy when another one is tightest.
- **G-05** `rate-limit.interceptor.ts:49-70`: headers are set only for the denying policy or the tightest; concurrency policies emit none; no `Cache-Control: no-store`; no `Retry-After` maximum across denying policies.
- **G-06** `rate-limit.interceptor.ts:46-66`: when a later policy denies, only concurrency leases are released; token-bucket units and sliding-window counts taken from earlier policies are kept (AS-40). Add a `refund` path per algorithm.
- **G-07** `rate-limit.interceptor.ts:11-21`: `Domain_RateLimitedError` puts the policy name in `detail` and has no `code`. Return `code: 'rate_limited'`, `retryAfterSeconds`, and a generic detail (FR-029). Add `Domain_RateLimiterUnavailableError` (503) and `Domain_RateLimitCostExceededError` (422).
- **G-08** Fail-closed outage gives a `429` with `Retry-After: 1` (`rate-limiter.service.ts:84-86`) → `503` `rate_limiter_unavailable` (AS-26).
- **G-09** `rate-limit.interceptor.ts:50-55`: a denied concurrency acquire sends a fixed `Retry-After: 5` and treats a store outage as "limit reached". Use the decision's `retryAfterMs` (clamp 1–5 s) and the `503` path for outages.
- **G-10** No per-route cost or custom subject: add the option object form of `@RateLimit` (`rate-limit.decorator.ts:9-13` takes names only) and the normalization of FR-003 (AS-06, AS-07).
- **G-11** No outcome handling: the interceptor does not look at the response status. Add the failures-only handling (G-17) in the same `tap`/`finalize` pipeline, plus release on abort (verify the existing `finalize` covers client abort, AS-20).
- **G-12** OPTIONS preflights are counted. Skip them (AS-46).
- **G-13** Verify the registration order: the default and `@RateLimit` interceptors run before the idempotency interceptor, and after the guards (FR-025, FR-031; AS-47). `apps/core/src/core.module.ts` provider order is where this is decided.

### Subjects (FR-035 to FR-039, AS-48 to AS-53)

- **G-14** `rate-limit.interceptor.ts:84`: `req.headers['cf-connecting-ip']` is trusted unconditionally, so any client sets it to get a fresh bucket (S01 AS-15). Use the platform-resolved client address only (S54/S01 FR-014); drop the header read.
- **G-15** `rate-limit.interceptor.ts:86-102`: `user` and `userOrIp` are the same branch; `user`, `apiKey` and `shop` fall back to the address silently (no counter, AS-50); the shop subject is the raw id (`:95`, FR-035 wants `shop:<id>`); the `custom` source does not exist; a custom value over 128 characters is not hashed. The e-mail branch is correct (`:96-100`) but `String(undefined ?? '')` for non-strings must keep mapping to the one fixed empty subject (AS-51); move derivation into a pure `subject.ts` and unit-test it.
- **G-16** No test proves that keys hold no secrets and all expire (AS-52).

### Algorithms and correctness (FR-001 to FR-013, AS-01 to AS-20, AS-83)

- **G-17** *(also failure-only counting)* Absent: `count: 'failures-only'`, reservation at admission, `refund`, `reset` (FR-040 to FR-042, AS-54 to AS-59). Needed by S01 (`auth.login.account`, `auth.reset.account`) and S02 (`auth.mfa.account`, shared by four code paths). Add a store-side decrement/clear script and the service methods.
- **G-18** `lua.ts:49-60` and `rate-limiter.service.ts:129-143`: the sliding window's window index and elapsed time come from the calling instance's `Date.now()` and the two window keys are built by string slicing (`:132-136`). Compute both inside the atomic step from the store clock (FR-010, AS-14), build the keys from one hash-tagged base (FR-013, AS-73), and return the exact retry delay (`lua.ts:57` returns the time to the end of the window, AS-13).
- **G-19** `lua.ts:13-40`: no `cost > capacity` guard (it returns a retry time that never comes true, AS-06); no pause state (G-20); the expiry is right (`PEXPIRE ceil(capacity/rate)+1000`, AS-08) and the capacity clamp on read already gives AS-83: add tests.
- **G-20** `penalize` is missing (FR-043 to FR-046, AS-60 to AS-65): add the pause marker on the token-bucket hash, `reason: 'paused'`, monotonic extension, cap, best-effort return, lease drop.
- **G-21** No public entry point: `libs/infrastructure/rate-limit` has no `index.ts`, and callers deep-import `@app/infrastructure/rate-limit/rate-limiter.service` (`assistant/application/answer.service.ts:6`, `assistant-quota.service.ts:5`, `catalog-sync/application/integration-sync.service.ts:9`, `catalog-import.service.ts:12`, `notifications/infra/notification-workers.service.ts:4`). Add the barrel; callers import from it.
- **G-22** Scripts are sent as text on every call (`rate-limiter.service.ts:35,99-107`); load once and call by digest with a single reload on "script not found" (FR-012, AS-33).
- **G-23** `rate-limiter.service.ts:55-60`: cost > 1 is not validated (AS-07); `check`'s `cost` is accepted but the fallback ignores it (G-26).
- **G-24** No injectable time source: tests cannot advance the store clock (AS-02, AS-11 to AS-13, AS-17, AS-19). Introduce the time-source port with the store clock as the production implementation (FR-010).
- **G-25** `rate-limiter.service.ts:37-49`: `acquire` swallows every error and returns `null` (closed) or a no-op (open): outage and "limit reached" are indistinguishable, the open path is unlimited (AS-34), no `Retry-After` hint, and the release is a bare `zrem` that is idempotent only by accident (AS-18 needs a test).

### Fail modes, breaker, fallback (FR-018 to FR-024, AS-26 to AS-36)

- **G-26** `rate-limiter.service.ts:12,87-94`: fallback fleet size is the constant 4 (make it `rate_limit_fallback_instances`), `bucket.take(key)` ignores `cost`, the share uses the token-bucket formula for sliding-window policies too without a test, and concurrency has no fallback (AS-29, AS-34). `in-memory-token-bucket.ts` is already bounded to 50,000 keys: keep, add the unit test.
- **G-27** No store timeout (`this.redis.client.eval(...)` has none): add `rate_limit_store_timeout_ms` (200 ms default), a paused-server test (AS-31), and no retry inside a decision (FR-019).
- **G-28** `rate-limiter.service.ts:150-161`: the breaker has no gauge, no transition log and is shared by every policy, which is acceptable; add the gauge and one log line per transition (AS-30, AS-75). Make 3 and 2 s configuration.
- **G-29** `rate-limiter.service.ts:81`: `logger.warn` on every failed decision with the raw driver message (can contain the host): during an outage this is a log flood and a minor leak. Log once per transition and count (AS-75), never the driver text.
- **G-30** No handling of helper errors (extractor, cost resolver, header formatting) under the fail mode (FR-023, AS-36).
- **G-31** `RedisThrottlerStorage` fails open inside the store catch (`redis-throttler.storage.ts:37-41`): goes away with G-33.

### Leased budget (FR-014 to FR-017, AS-21 to AS-25)

- **G-32** `rate-limiter.service.ts:40-56,66-85`: lease handling is correct (adds, never overwrites; single-flight refill). Missing: the denial memo (FR-016, AS-25), lease off for `cost > 1` is present (`:64`) but untested (AS-24), `localLeaseFraction` has no range validation (AS-69), lease lifetime is a constant (`:10`, make `rate_limit_lease_ttl_ms`). The existing e2e `local leases` (`rate-limit.e2e-spec.ts:44-55`) asserts `< 200` calls; tighten to the `≤ 40` of AS-21.

### Defaults and exemptions (FR-047 to FR-049, AS-66 to AS-68)

- **G-33** The global `ThrottlerGuard` is a *guard* (runs before the identity is known, keyed per address, fixed window with the 2× boundary burst): `apps/core/src/core.module.ts:27,39,68-79,172`, `apps/sse-gateway/src/sse-gateway.module.ts:11,55-62,121`, `rate-limit/redis-throttler.storage.ts` (whole file), `test/utils/global-modules.ts:13,100-145`, config keys `throttle_api_limit` / `throttle_api_ttl` (`libs/common/config/api-config.service.ts:105-110`, `types.ts:29-30`). Delete all of it (FR-048); `RateLimitModule.forRoot()` registers a global interceptor that applies `default.read` / `default.write` (keyed `userOrIp`) to routes with no `@RateLimit` and no exemption. `apps/public-api/src/public-api-app.module.ts:20` imports the module with no default today.
- **G-34** `libs/domains/identity/api/decorators/firewall.decorator.ts:11,15,36-47`: `Firewall({ throttle, skipThrottle })` wraps the throttler. Remove the two options (S01's file; coordinate) and replace the ~25 `skipThrottle: true` uses and the one `@SkipThrottle()` with the default, an explicit policy, or `@RateLimitExempt(reason)`: `sse-gateway/src/live/live-stream.controller.ts:26`, `topic-stream/topic-stream.controller.ts:38`; `auctions/api/auctions.controller.ts:31`; `marketing/api/ads.controller.ts:38`, `share-links.controller.ts:44`; `assistant/api/assistant.controller.ts:71,83`, `knowledge.controller.ts:77`; `content/api/stories.controller.ts:66,88,105`; `catalog-sync/api/integrations.controller.ts:36`; `billing/api/billing.controller.ts:17`; `launch-events/api/launch-events.controller.ts:30,53`; `fulfilment/api/pickup.controller.ts:71`, `delivery.controller.ts:66`; `experimentation/api/analytics.controller.ts:17`; `tenancy/api/shop-batch-read.controller.ts:17`; `community/api/discussions.controller.ts:26,32,38`; `developer-platform/api/widget.controller.ts:46`; `orders/api/stripe-webhook.controller.ts:23` (`@SkipThrottle()`: becomes `@RateLimitExempt('payment provider webhook, signature-verified')`, S10 may give it `orders.webhook.ip` instead).
- **G-35** Mis-used policies (each owner's spec names the replacement; this list is for the implementer): `search.query` on non-search routes: `fulfilment/api/pickup.controller.ts:57,65`, `launch-events/api/launch-events.controller.ts:38`, `catalog-sync/api/sync.controller.ts:33`, `discovery/api/recommendations.controller.ts:14`, `experimentation/api/analytics.controller.ts:18`; `discussion.write` on non-discussion routes: `media/api/media.controller.ts:28`, `marketing/api/share-links.controller.ts:21`; `auth.login.ip` on `developer-platform/api/widget.controller.ts:57`; `exports.concurrent` on statements (`statements/api/statements.controller.ts:35`, S16 renames it `statements.export.concurrent`); `imports.concurrent` (`catalog-sync/application/catalog-import.service.ts:100`, goes away with S07).

### Observability (FR-054, AS-74, AS-75)

- **G-36** `rate-limiter.service.ts:23`: one counter (`rate_limit_decisions_total` with `policy`, `allowed`, `source`). Add the `reason` label, the duration histogram, `rate_limit_store_unavailable_total`, the breaker gauge, `rate_limit_subject_fallback_total`, `rate_limit_penalties_total`, with label values `store | local-lease | fallback`. Add sampled, redacted denial logs with `requestId`.

### Edge worker (FR-057, FR-058, AS-76 to AS-79)

- **G-37** `packages/edge-be/src/index.ts:41-84`: the script returns only `0/1`, so no retry hint; the `429` at `:336` and `:401` is a bare `{"error":"Rate limit exceeded"}` with no `Retry-After`, no `RateLimit*` headers and no problem+json; the subject falls back to the shared string `anonymous` (acceptable per AS-79) but there is no counter or log when the store is slow or down (`:81-83` swallows); two call sites duplicate the same block. Return the remaining count and reset from the script, build one `rateLimitResponse()` helper in the problem+json and header format of AS-37, count and log the fail-open path. There is **no spec file** for the worker today: add `packages/edge-be/src/rate-limit.spec.ts` (AS-76 to AS-79) against a fake edge store.

### Tests (VII.2, VII.8, VII.9)

- **G-38** `rate-limit.e2e-spec.ts` (95 lines, 6 tests) is one file that (a) imports a domain module (`AuthApiModule`, `:8`; X.5), (b) proves the outage case by hand-building `new RateLimiterService({ client: { eval: reject } })` (`:77-80`): that is a mock of the project's own store client, forbidden by VII.2, (c) asserts `ratelimit-limit` headers of the old format (`:93`), (d) has no HTTP test of the default, subject isolation, cost, penalties, failure-only, timeouts, the breaker or recovery. Replace with the 13 files of `test-plan.md` using the test controller module and real store-connection faults.
- **G-39** `scripts/load-tests/ratelimit.test.js`: update for the new headers and the `503` path; add the 1/2/4-instance run and the store-call ratio of SC-005.
- **G-40** Update the pattern map rows P0113, P0214, P0327, P0416 from `implemented` to `verified` once the files above pass, and SD-28's implementation notes to the new header format and the removal of the throttler.

## Policy declarations other capabilities must add

Each owner declares these in its own domain with `definePolicies` + `forFeature` (G-01). Names are exact (other specs quote them); numbers are copied from the owning spec's contract section, where they are authoritative. "closed/open" is the fail mode. Where the number is not shown, read the owning spec.

| Owner | Policies |
|---|---|
| S01 | `auth.register.ip` (10/h, closed), `auth.login.ip` (20/min), `auth.login.account` (5 failures/15 min, failures-only, reset on success), `auth.refresh.ip` (60/min), `auth.reset.ip`, `auth.reset.account` (3/h); all closed |
| S02 | `auth.mfa.ip` 20/min, `auth.mfa.account` 5 failures/15 min (failures-only), `auth.oidc.ip` 30/min; all closed |
| S03 | `tenancy.shop-create.user` 5/h, `tenancy.invite.shop` 20/h, `tenancy.invite-accept.user` 10 failures/15 min, `tenancy.invite-accept.ip` 30/min, `tenancy.sso-lookup.ip` 30/min, `tenancy.shop-write.shop` 120/min; all closed |
| S04 | `onboarding.upload.shop` 20/h, `onboarding.submit.shop` 10/day; closed |
| S05 | `catalog.product-read.ip` 600/min open, `catalog.product-write.shop` 120/min closed, `catalog.batch-read.ip` 120/min open |
| S06 | `catalog.draft-connect.user` 30/min, `catalog.draft-write.shop` 120/min, `catalog.draft-publish.shop` 10/min; closed |
| S07 | `catalog-sync.import-start.shop` 10/h closed (drop `imports.concurrent`) |
| S08 | `integrations.shopify` 40 per 20 s (exists), `integrations.woocommerce` burst 20 at 5/s, `catalog-sync.integration-write.shop` 30/min, `catalog-sync.sync-now.integration` 1/min, `catalog-sync.reconcile-now.integration` 1/h, `catalog-sync.webhook.integration` 1,200/min, `catalog-sync.webhook.ip` 600/min (webhook ones fail open per S08 AS-32; the rest closed) |
| S09 | `catalog-sync.sync-push.device` 30/min, `catalog-sync.sync-pull.device` 120/min, `catalog-sync.conflict-write.shop` 60/min; closed |
| S10 | `orders.cart-write.identity` 120/min open, `checkout.create` 10/min closed (exists), `orders.cancel.user` 20/min closed, `orders.webhook.ip` 300/min open |
| S11 | `orders.flash-reserve.user` 30/min per buyer per sale closed, `orders.flash-sale-read.ip` 600/min open |
| S12 | `orders.export-start.shop` 5/h closed |
| S13 | `payments.create.user` 10/min closed, `payments.read.user` 120/min open |
| S14 | `finance.balance.read` 120/min open, `finance.admin.read` 120/min open, `finance.admin.write` 30/min closed |
| S15 | `finance.payouts.read` 120/min open (admin ones are S14's) |
| S16 | `statements.read` 120/min open, `statements.export.concurrent` 2 per shop (concurrency, closed), `statements.admin.read` 120/min open, `statements.admin.write` 30/min closed |
| S17 | `billing.subscribe.subject` 10/h, `billing.change.subject` 30/h, `billing.preview.subject` 60/min, `billing.payment-method.subject` 5/h, `billing.plans.ip` 120/min open; the rest closed |
| S18 | `billing.usage-read.subject` 60/min closed |
| S19 | `fulfilment.near-search` 120/min user-or-address open, `fulfilment.map-clusters` 300/min open |
| S20 | `fulfilment.courier-locations` 30/min open, `fulfilment.delivery-request` 60/min closed, `fulfilment.delivery-actions` 120/min open |
| S21 | `auction.bid` 10 per 10 s closed (exists), `auctions.read.ip` 600/min open |
| S22 | `launch.queue.join.user` 10/min open, `launch.hold.user` 30/min closed, `launch.seatmap.ip` 600/min open |
| S23 | `live.comment` 3 per 10 s, `live.reaction` 5/s, `live.snapshot.ip` 120/min, `live.events.ip` 30/min; open |
| S24 | `chat.send.user` 10 per 10 s, `chat.sync.user` 30/min, `chat.read.user` 60/min, `chat.heartbeat.user` 6/min, `chat.presence.user` 30/min, `chat.channel-create.user` 10/h, `chat.ws-ticket.user` 30/min; all open |
| S25 | `discussion.write` 10/min closed, `discussion.vote` 60/min open with lease (both exist) |
| S26 | `follow.write` 30/min closed, `feed.read` 120/min open |
| S27 | `content.write.shop` 120/min closed |
| S28 | `notifications.read.user`, `notifications.write.user`, `notifications.phone-code.user`, `notifications.phone-verify.user`, `notifications.unsubscribe.ip`, `notifications.webhook.ip`; send budgets `notify.email` 14/s, `notify.sms` 10/s, `notify.push` 500/s (exist) and `notify.<channel>.marketing` variants |
| S29 | `media.upload.user` 30/min, `media.upload.shop` 120/min, `media.gallery.shop` 60/min closed; `media.read.ip` 600/min open |
| S30 | `video.start.shop` 20/h closed, `video.write.shop` 120/min closed, `video.playback.ip` 600/min open |
| S31 | `assets.upload.shop` 120/min closed, `assets.redeem.ip` 60/min open, `assets.grant.user` 30/min closed |
| S32 | `discovery.search.query` 120/min user-or-address open, `discovery.shop-search` 120/min per user and shop open, `discovery.search-click` 300/min open, `discovery.search-admin` 30/min closed |
| S33–S35 | `discovery.suggest` 600/min, `discovery.recommendations` 600/min, `discovery.trending` 300/min; per address, open |
| S36 | `marketing.ads-write.shop` 60/min closed, `marketing.ads-read.shop` 300/min open, `marketing.ads-serve.ip` 120/min open (the click endpoint has none) |
| S37 | `share-link.create` 20/min per user closed |
| S39 | `analytics.ingest` 120/min open, `experiments.assignments` 120/min open, `experiments.admin.write` 30/min closed, `experiments.results` 20/min closed |
| S40, S41 | S40: a fail-open policy per its spec; S41: `seller-insights.competitor-write.shop` closed |
| S42 | `public-api.default` token bucket 6,000/min per API key, open, with per-request cost; `public-api.auth-failure.ip` 30/min closed |
| S43 | `webhooks.manage.shop` 120/min, `webhooks.replay.shop` 30/min, `webhooks.ping.endpoint` 10/min; closed |
| S44 | `widget.config.ip` 600/min open, `widget.identify.ip` 30/min closed, `widget.identify.site` 1,200/min closed, `widget.manage.shop` 60/min closed |
| S45 | `shop-functions.submit.shop` 10/h closed |
| S46 | `llm.messages` 20/min closed (exists), `llm.provider.tpm` 2,000,000/min per model open with cost (exists) |
| S47 | `rag.ask` 10/min user-or-address closed (exists), `rag.ingest` 30/min per shop closed |
| S48 | `bff.product-page.principal` 300/min, `bff.graphql.cost` 20,000 units/min (cost-weighted), `bff.session.login.ip` 20/min |

## Suggested order for the implementation agent

1. Contracts and pure code first: policy types and `definePolicies`, validator, subject derivation, header formatter, cost normalization, key builder, fallback limiter (unit tests green).
2. Time-source port and scripts: sliding window on store time, cost guard, pause, failure-only reserve/refund/reset; load scripts by digest (TB, SW, CONC, PEN, FONLY e2e).
3. Service: timeout, breaker with metrics and logs, fail modes and reasons, denial memo, `acquire` result shape (FAIL, LEASE).
4. Interceptor and default: header contract, refund on later denial, outcome handling, OPTIONS skip, order versus idempotency; delete the throttler, `Firewall` options and config keys (HTTP, REG).
5. Move policy declarations to owners (table above) in step with each owner's capability; keep a temporary compatibility re-export only until each owner lands, and delete it with the last one.
6. Edge worker and its spec (EDGE); update the k6 script; run `check:boundaries` and `check:table-ownership --strict`; update the pattern map.

## Follow-ups from built specs

- **S52**: `app.set('etag', false)` (`bootstrap-http.ts:184`) stays. HTTP e2e asserts that `429`, `503` and write responses carry no body-hash `ETag` and are never answered `304`. No S50 route relies on an automatic ETag.
- **S54**: the replay header is `Idempotency-Replayed`. `spec.md` AS-47 and Requires (7) were renamed; the bootstrap already exposes the new name; HTTP e2e AS-47 asserts it.

## Sibling-spec follow-ups

- **S01**: remove `throttle`/`skipThrottle` from `Firewall(...)` (`firewall.decorator.ts`); declare `auth.*` policies with `definePolicies` + `forFeature`; `auth.login.account` and `auth.reset.account` use `count: 'failures-only'` with `resetOnSuccess`; the address comes from `req.clientIp` only (no `cf-connecting-ip`).
- **S02**: declare `auth.mfa.ip`, `auth.mfa.account` (failures-only, shared by four code paths through `refund`/`reset`) and `auth.oidc.ip`.
- **S07**: drop `imports.concurrent` and its `acquire` call (`catalog-import.service.ts:100`); `acquire` now returns `{ acquired, release, decision }`.
- **S08**: use `penalize(policy, subject, ms)`; other workers' `check` returns `reason: 'paused'`.
- **S10**: replace `@SkipThrottle()` on the Stripe webhook with `@RateLimitExempt('payment provider webhook, signature-verified')` or `orders.webhook.ip`.
- **S24**: derive `chat_limiter_unavailable_total` from `rate_limit_store_unavailable_total` by policy prefix.
- **S16, S19, S22, S29, S32–S35, S37, S39, S44**: replace the mis-used policies listed in G-35 with their own declared names; the transitional `legacy-policies.ts` goes away with the last owner.
- **S25, S26, S28, S36, S42, S46, S47, S48 and every other owner in the table above**: move your policy numbers into your domain with `definePolicies` + `forFeature`; adopt the structured `RateLimit`/`RateLimit-Policy` headers and the `503 rate_limiter_unavailable` / `422 rate_limit_cost_exceeded` answers in your contracts and clients.
- **S54**: nothing new to build. Keep the idempotency interceptor route-scoped (after the global rate-limit interceptors), keep `req.clientIp` set, keep the replay header `Idempotency-Replayed`.
