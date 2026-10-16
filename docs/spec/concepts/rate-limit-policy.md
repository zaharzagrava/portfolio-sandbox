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
- {{cap:S07}} Bulk catalog import (multipart upload, malware scan, streamed parse, checkpoints and leases, error report)
- {{cap:S08}} Shopify and WooCommerce catalog and stock sync (connect, incremental pull, webhooks, three-way stock merge, quarantine, resilience, reconciliation, management)
- {{cap:S09}} Offline-first inventory sync for store devices (operation idempotency, stock deltas, per-field last-writer-wins, change feed, conflicts)
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S11}} Flash sales (scheduled drops, bucketed fast stock, admission, never oversell, async reconciliation)
- {{cap:S12}} Order export (streamed CSV to object storage, live progress, fenced worker, retention)
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S15}} Seller payouts - weekly run, reserves, provider transfer with idempotency, payout states
- {{cap:S16}} Seller statements - bitemporal commission rates, monthly statements, close, adjustments, CSV, reconciliation
- {{cap:S17}} Subscriptions - plans, versioned prices, state machine, billing run, charging and dunning, proration, credit
- {{cap:S18}} Usage metering (late events, adjustments) and entitlement checks
- {{cap:S19}} Pickup points, local stock, available near me, map clustering
- {{cap:S21}} Limited-drop auctions (proxy bids, anti-sniping, reserve, exactly-once close, second chance, shill guard)
- {{cap:S24}} Product chat (channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push)
- {{cap:S25}} Product discussions (posts, nested comments, votes, ranking, abuse controls, safe markdown)
- {{cap:S28}} Notification routing, preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression
- {{cap:S29}} Product and review photos (upload, safe processing, duplicate flag, galleries, cleanup)
- {{cap:S30}} Product video and VOD (resumable upload, transcoding graph, HLS ladder, signed delivery)
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:S34}} "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
- {{cap:S35}} Trending products: windowed approximate top-K per category
- {{cap:S36}} Sponsored listings (campaigns, signed click tokens, click counting, hourly billing, daily reconciliation)
- {{cap:S37}} Share and affiliate short links (codes, aliases, redirects, click attribution)
- {{cap:S38}} Feature flags and remote config (targeting, percentage rollout, local evaluation, kill switch, audit)
- {{cap:S39}} Analytics ingestion and A/B testing (event schema, dedupe, assignment, exposure, SRM, results)
- {{cap:S42}} Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch and bulk stock, request logs, usage metering
- {{cap:S43}} Webhook delivery to shops: endpoints, signing with dual secrets, routing, per-endpoint ordering, retries, circuit breaker, auto-disable, replay
- {{cap:S44}} Embeddable storefront widget: site keys bound to origins, per-site framing policy, identity hand-off, kill switch
- {{cap:S46}} Streamed shopping assistant (read-only tools, resumable streams, allowance, fallback model, moderation, metering, shared model provider port)
- {{cap:S47}} Ask this product and the shop help center (knowledge documents, ingestion, hybrid retrieval, cited answers)
- {{cap:S48}} BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S51}} Realtime push hub: topic SSE, Last-Event-ID replay, per-topic policies, ref-counted fan-out
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
- {{cap:W01}} Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
- {{cap:W07}} App shell and cross-cutting UI: navbar, footer, legal pages, developer docs, error/not-found/loading states, responsive layout, accessibility, CSP and security headers
<!-- used-by:end -->
