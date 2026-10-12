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
- **transaction-runner.C-01** A transaction scope MUST commit on success and MUST roll back on any error, rethrowing the error unchanged.
- **transaction-runner.C-02** `afterCommit` callbacks MUST run once, after commit, in registration order, and MUST NOT run on rollback.
- **transaction-runner.C-03** Services MUST share the active transaction without receiving a transaction object, so a failure in one service leaves no row from another.
- **transaction-runner.C-04** A serializable scope MUST retry only error codes `40001` and `40P01`, up to 3 attempts in total.
- **transaction-runner.C-05** When serializable retries run out, the scope MUST return `503 transaction_conflict`.
- **transaction-runner.C-06** Statement and lock timeouts MUST be integers from 1 to 600 000 ms and MUST NOT be interpolated into SQL.
- **transaction-runner.C-07** The outbound HTTP client, `safeGet` and `safeRequest` MUST refuse to send while a transaction is active.
- **transaction-runner.C-08** Outbox rows MUST be written in the caller's transaction, through `append` or `appendTask`.
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
- {{cap:S01}} Registration, password login, sessions, refresh-token rotation, JWKS, service-to-service tokens
- {{cap:S02}} TOTP MFA with recovery codes, Google OIDC login (PKCE), account linking
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
<!-- used-by:end -->
