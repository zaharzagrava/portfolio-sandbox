---
id: rate-limit-policy
title: Rate-limit policies
kind: concept
status: draft
defined_by: S50
---
# Rate-limit policies
## Definition
A rate-limit policy is a named rule that caps how often one subject (address, user, API key, shop, hashed e-mail) can use a route or a code path. It declares an algorithm (token bucket, sliding window or concurrency), a `limit`, a `windowMs` and a `failMode` (`open` or `closed`). Every capability that limits traffic gets the same decisions, headers and errors. Each decision is atomic in the shared store, so admitted units never exceed the budget across instances. Subjects and policies never share a budget.

## Rules
- **rate-limit-policy.C-01** Every policy MUST declare an [algorithm](../terms/rate-limit.md), a `limit`, a [`windowMs`](../terms/rate-limit.md) and a [`failMode`](../terms/rate-limit-fail-mode.md) of `open` or `closed`.
- **rate-limit-policy.C-02** [Buckets](../terms/rate-limit-bucket.md) of different [subjects](../terms/rate-limit-subject.md), and of one subject on different policies, MUST be independent.
- **rate-limit-policy.C-03** Each decision MUST be one [atomic step ↗](../sw-external-terms.md#atomic-increment) in the [shared store](../terms/rate-limit-counter-store.md) and MUST use the store's clock only, never an [instance clock](../terms/store-clock.md).
- **rate-limit-policy.C-04** A denied request MUST answer [`429` problem+json ↗](../sw-external-terms.md#problem-json) with [`Retry-After` ↗](../sw-external-terms.md#retry-after), without the policy name or the [subject](../terms/rate-limit-subject.md) in its fields.
- **rate-limit-policy.C-05** A [`cost`](../terms/rate-limit-cost.md) MUST be a positive integer; `check` MUST throw [`InvalidRateLimitCostError`](../terms/invalid-rate-limit-cost-error.md) otherwise, and a `cost` above the `limit` MUST answer `422` [`rate_limit_cost_exceeded`](../terms/rate-limit-cost-exceeded.md).
- **rate-limit-policy.C-06** Under [fail closed](../terms/rate-limit-fail-mode.md), a store failure MUST answer `503` [`rate_limiter_unavailable`](../terms/rate-limiter-unavailable.md) with [`Retry-After: 1` ↗](../sw-external-terms.md#retry-after).
- **rate-limit-policy.C-07** Under [fail open](../terms/rate-limit-fail-mode.md), an in-process [fallback token bucket ↗](../sw-external-terms.md#token-bucket) of capacity `max(1, floor(limit ÷ fleetSize))` MUST decide, keeping at most 50,000 subjects.
- **rate-limit-policy.C-08** The [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) MUST open after 3 consecutive store failures, skip the store for 2 s, then allow [one probe](../terms/circuit-breaker-probe.md).

## How the capabilities use it
- {{cap:S01}} relies on the policies `auth.register.ip`, `auth.login.ip`, `auth.login.account`, `auth.refresh.ip`, `auth.reset.ip` and `auth.reset.account`.
- {{cap:S05}} limits a shop to 120 writes per minute; the 121st gives `429 rate_limited` and reads still work.
- {{cap:S10}} limits cart writes (`PUT`, merge) to 120 per minute per identity, with `Retry-After`; reads are not limited.
- {{cap:S13}} limits `POST /payments/intents` to 10 per buyer per minute and fails closed when the limiter store is down.
- {{cap:S32}} limits search by policy `discovery.search.query` to 120 per minute per user or address, with `429` and `Retry-After`.
- {{cap:S34}} limits recommendations by policy `discovery.recommendations` to 600 requests per minute per address; the 601st answers `429` `rate_limited`.
- {{cap:S48}} limits the page endpoint to 300 requests per minute per principal; the 301st gives `429 rate_limited`.
- {{cap:S50}} defines the limiter, its three algorithms, the headers and the fail modes.

## Known gaps
- S02, S03, S33, S35, S51, S54, W01, W02, W03 and W07 list this concept but no line links it, so their use is not stated.
- The facts give no `limit` or `windowMs` for the S01 policies.
- The facts do not state which algorithm each capability's policy uses, except S13 and S50.

## Used by
<!-- used-by:start -->
- {{cap:S01}} Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
- {{cap:S02}} TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:S34}} "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
- {{cap:S35}} Trending products: windowed approximate top-K per category
- {{cap:S48}} BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S51}} Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
- {{cap:W01}} Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
- {{cap:W07}} App shell and cross-cutting UI: navbar, footer, legal pages, developer docs, error/not-found/loading states, responsive layout, accessibility, CSP and security headers
<!-- used-by:end -->
