---
id: transaction-runner
title: Transactions and the transaction runner
kind: concept
status: draft
defined_by: S54
---
# Transactions and the transaction runner
## Definition
The transaction runner is the shared toolkit scope that runs a unit of work as one database transaction. Services inside the scope share the transaction without receiving a transaction object. The scope commits on success and rolls back on any error. It runs `afterCommit` callbacks only after a commit. A serializable scope retries conflicts. No outbound HTTP call is allowed while a transaction is active. Capabilities get all-or-nothing writes and no external call inside a transaction.
## Rules
- **transaction-runner.C-01** A [transaction scope](../terms/transaction-scope.md) MUST commit on success and MUST [roll back ↗](../sw-external-terms.md#database-transaction) on any error, rethrowing the error unchanged.
- **transaction-runner.C-02** [`afterCommit` callbacks](../terms/after-commit-callback.md) MUST run once, after commit, in registration order, and MUST NOT run on [rollback ↗](../sw-external-terms.md#database-transaction).
- **transaction-runner.C-03** Services MUST share the [active transaction](../terms/active-transaction.md) without receiving a transaction object, so a failure in one service leaves no row from another.
- **transaction-runner.C-04** A [serializable scope](../terms/transaction-scope.md) MUST retry only error codes [`40001` ↗](../sw-external-terms.md#postgres-serialization-errors) and `40P01`, up to 3 attempts in total.
- **transaction-runner.C-05** When serializable retries run out, the scope MUST return [`503 transaction_conflict`](../terms/transaction-conflict.md).
- **transaction-runner.C-06** [Statement and lock timeouts](../terms/transaction-timeouts.md) MUST be integers from 1 to 600 000 ms and MUST NOT be [interpolated into SQL ↗](../sw-external-terms.md#sql-injection).
- **transaction-runner.C-07** The outbound HTTP client, [`safeGet`](../terms/safe-http-client.md) and `safeRequest` MUST refuse to send while a transaction is active.
- **transaction-runner.C-08** [Outbox rows](../terms/inbox-table.md) MUST be written in the caller's transaction, through [`append`](../terms/outbox-append.md) or [`appendTask`](../terms/outbox-append-task.md).
## How the capabilities use it
- {{cap:S13}} writes the payment, its history row, the charge command and the idempotency record in one transaction, and makes no provider call or publish inside it.
- {{cap:S53}} writes event and task rows in the caller's transaction with `append` and `appendTask`; `appendStandalone` needs no transaction.
- {{cap:S54}} defines `run` and the `@Transactional` decorator, and the retry, timeout and outbound-call rules.
## Known gaps
- S01, S02, S03, S05, S10 and S49 list this concept, but no line of their pages links it. Their use is not stated.
- The facts do not say how `run` and `@Transactional` differ, or how a serializable scope is requested.
- The facts do not say what happens to `afterCommit` callbacks that throw.

## Used by
<!-- used-by:start -->
- {{cap:J03}} Launch day: waiting room and seat booking, flash-sale purchase without overselling, live stream comments, an auction closing with the winner's checkout, and the notifications each triggers
- {{cap:S01}} Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
- {{cap:S02}} TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S04}} Staged onboarding questionnaire, KYC document intake, LLM extraction, human review, shop verification
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S06}} Collaborative listing drafts - real-time co-editing, versions, publish to a product
- {{cap:S07}} Bulk catalog import (multipart upload, malware scan, streamed parse, checkpoints and leases, error report)
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S11}} Flash sales (scheduled drops, bucketed fast stock, admission, never oversell, async reconciliation)
- {{cap:S12}} Order export (streamed CSV to object storage, live progress, fenced worker, retention)
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S15}} Seller payouts - weekly run, reserves, provider transfer with idempotency, payout states
- {{cap:S16}} Seller statements - bitemporal commission rates, monthly statements, close, adjustments, CSV, reconciliation
- {{cap:S17}} Subscriptions - plans, versioned prices, state machine, billing run, charging and dunning, proration, credit
- {{cap:S18}} Usage metering (late events, adjustments) and entitlement checks
- {{cap:S20}} Same-day courier dispatch (courier shift, offers, delivery state machine, tracking)
- {{cap:S21}} Limited-drop auctions (proxy bids, anti-sniping, reserve, exactly-once close, second chance, shill guard)
- {{cap:S22}} Launch-event booking (waiting room, admission tokens, seat holds, booking confirm, seat map, ticket limits)
- {{cap:S23}} Live launch stream (sampled comment batches, reactions, moderation, pinned commerce)
- {{cap:S24}} Product chat (channels, idempotent send, per-channel sequence, sync on reconnect, unread, receipts, presence, offline push)
- {{cap:S27}} Brand stories CMS (versioned multi-locale stories, scheduled publish, preview, cache tags, sitemap)
- {{cap:S28}} Notification routing, preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression
- {{cap:S29}} Product and review photos (upload, safe processing, duplicate flag, galleries, cleanup)
- {{cap:S30}} Product video and VOD (resumable upload, transcoding graph, HLS ladder, signed delivery)
- {{cap:S31}} Shop asset library (chunked dedupe, delta sync, conflicts, share links) and digital product delivery
- {{cap:S36}} Sponsored listings (campaigns, signed click tokens, click counting, hourly billing, daily reconciliation)
- {{cap:S38}} Feature flags and remote config (targeting, percentage rollout, local evaluation, kill switch, audit)
- {{cap:S39}} Analytics ingestion and A/B testing (event schema, dedupe, assignment, exposure, SRM, results)
- {{cap:S41}} Competitor price monitor (watches, polite SSRF-safe crawling, robots.txt, price extraction, change detection, price-drop alerts)
- {{cap:S42}} Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch and bulk stock, request logs, usage metering
- {{cap:S43}} Webhook delivery to shops: endpoints, signing with dual secrets, routing, per-endpoint ordering, retries, circuit breaker, auto-disable, replay
- {{cap:S44}} Embeddable storefront widget: site keys bound to origins, per-site framing policy, identity hand-off, kill switch
- {{cap:S45}} Seller discount functions (sealed runtime, online judge, versions, checkout evaluation with circuit breaker)
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
<!-- used-by:end -->
