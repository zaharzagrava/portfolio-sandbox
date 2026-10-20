---
id: idempotency-key
title: Idempotency keys
kind: concept
status: draft
defined_by: S54
---
# Idempotency keys
## Definition
An idempotency key is a client-chosen string of 8 to 128 characters. It lets a client repeat a write request and get one effect. The platform toolkit (S54) declares it per route with `@Idempotent` and purges old keys with a job. Checkout, payment start and job enqueue use it. A retry with the same key creates no second order, charge or job. The client keeps one key for all retries of one attempt.

## Rules
- **idempotency-key.C-01** A route declared with [`@Idempotent`](../terms/idempotent-decorator.md) MUST require an `Idempotency-Key` header, and `POST /checkout` MUST answer `422 idempotency_key_required` when the key is missing.
- **idempotency-key.C-02** An `Idempotency-Key` on `POST /checkout` MUST have 8 to 128 characters.
- **idempotency-key.C-03** `POST /payments/intents` MUST require an `Idempotency-Key`, answer [`202` ↗](../sw-external-terms.md#http-202-accepted) with [`Location` ↗](../sw-external-terms.md#location-header), and MUST NOT call the [payment provider](../terms/payment-provider.md).
- **idempotency-key.C-04** [Job enqueue](../terms/job-enqueue.md) with an existing key MUST create nothing and MUST return the original id with [`created: false`](../terms/enqueue-created-flag.md).
- **idempotency-key.C-05** Under 20 [concurrent enqueue calls](../terms/job-enqueue.md) with one key, exactly one call MUST see [`created: true`](../terms/enqueue-created-flag.md).
- **idempotency-key.C-06** The UI MUST reuse the same key for every retry of one [attempt](../terms/checkout-attempt.md), including after a reload, by keeping the attempt in the tab's [session storage ↗](../sw-external-terms.md#session-storage).
- **idempotency-key.C-07** A repeated request with the same key MUST still count against the route's [rate limit](../terms/rate-limit.md), so the fourth of four identical requests at a limit of 3 gets [`429` ↗](../sw-external-terms.md#http-429-too-many-requests).

## How the capabilities use it
- {{cap:S10}} requires the key on `POST /checkout` (8 to 128 characters) and answers `422 idempotency_key_required` without it.
- {{cap:S13}} requires the key on `POST /payments/intents`, which answers `202` with `Location` and never calls the provider.
- {{cap:S49}} uses the key on enqueue to return the original job id with `created: false` and to give one winner under 20 concurrent calls.
- {{cap:S50}} counts requests that carry a key against the rate limit; the fourth request at a limit of 3 gets `429`.
- {{cap:S54}} defines the `@Idempotent` route declaration and the purge job.
- {{cap:W03}} keeps the attempt key in session storage, so a double press or reload creates one order.

## Known gaps
- The S54 page was given without lines that define the key's storage, its lifetime, the purge schedule, or the reply to a repeated key with a different request body. Rules C-01 and C-07 are inferred only from the lines of S10, S13 and S50.
- S05 and S53 list the concept, but no line links it, so they are not described.
- The 8 to 128 character limit is stated only for `POST /checkout`.

## Used by
<!-- used-by:start -->
- {{cap:J01}} Buyer pays for a multi-shop order; order paid → ledger journals → settlement → seller payout → monthly statement; buyer and sellers notified
- {{cap:J02}} New seller registers, creates a shop, passes onboarding/KYC, subscribes to a plan, lists a product that becomes searchable, sells it, receives the order webhook, and appears on the leaderboard
- {{cap:J03}} Launch day: waiting room and seat booking, flash-sale purchase without overselling, live stream comments, an auction closing with the winner's checkout, and the notifications each triggers
- {{cap:J04}} A shop imports its catalog (bulk file and Shopify), products become searchable and available near me, an offline store device sells stock, and the stock change syncs back to Shopify
- {{cap:S04}} Staged onboarding questionnaire, KYC document intake, LLM extraction, human review, shop verification
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S06}} Collaborative listing drafts - real-time co-editing, versions, publish to a product
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S15}} Seller payouts - weekly run, reserves, provider transfer with idempotency, payout states
- {{cap:S16}} Seller statements - bitemporal commission rates, monthly statements, close, adjustments, CSV, reconciliation
- {{cap:S17}} Subscriptions - plans, versioned prices, state machine, billing run, charging and dunning, proration, credit
- {{cap:S19}} Pickup points, local stock, available near me, map clustering
- {{cap:S20}} Same-day courier dispatch (courier shift, offers, delivery state machine, tracking)
- {{cap:S21}} Limited-drop auctions (proxy bids, anti-sniping, reserve, exactly-once close, second chance, shill guard)
- {{cap:S22}} Launch-event booking (waiting room, admission tokens, seat holds, booking confirm, seat map, ticket limits)
- {{cap:S24}} Product chat (channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push)
- {{cap:S25}} Product discussions (posts, nested comments, votes, ranking, abuse controls, safe markdown)
- {{cap:S27}} Brand stories CMS (versioned multi-locale stories, scheduled publish, preview, cache tags, sitemap)
- {{cap:S31}} Shop asset library (chunked dedupe, delta sync, conflicts, share links) and digital product delivery
- {{cap:S37}} Share and affiliate short links (codes, aliases, redirects, click attribution)
- {{cap:S42}} Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch and bulk stock, request logs, usage metering
- {{cap:S43}} Webhook delivery to shops: endpoints, signing with dual secrets, routing, per-endpoint ordering, retries, circuit breaker, auto-disable, replay
- {{cap:S46}} Streamed shopping assistant (read-only tools, resumable streams, allowance, fallback model, moderation, metering, shared model provider port)
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
- {{cap:S55}} Lambda workers: partial batch failure, idempotent effects, manifest, dead letters, local runner, bundles
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
- {{cap:W04}} Seller dashboard (shop entry and switcher, live overview, inventory, API keys, webhooks, API version, request logs, usage, team, invitations, orders)
- {{cap:W05}} Chat and shopping assistant (product chat inbox and conversation, live delivery, read receipts, presence, assistant sheet and streaming answers)
<!-- used-by:end -->
