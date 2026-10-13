---
id: outbox-task-queue
title: The outbox: events and tasks
kind: concept
status: draft
defined_by: S53
---
# The outbox: events and tasks
## Definition
The outbox is the shared event backbone. A domain writes each event to an outbox row in the same database transaction as its state change. A relay then publishes the row to Kafka at least once. Consumers apply each event once in effect, using an inbox, a version guard or a natural key. No event is lost, and a rolled-back change leaves no event. Domains react to each other without sharing a table. Capability {{cap:S53}} owns the outbox and inbox tables.

## Rules
- **[outbox ↗](../sw-external-terms.md#transactional-outbox)-task-queue.C-01** A domain MUST append events through the outbox in the caller's transaction; without an active transaction, `append` MUST reject with [`NoActiveTransactionError`](../terms/no-active-transaction-error.md), and a [rollback](../terms/outbox-rollback.md) MUST leave no outbox row.
- **outbox-task-queue.C-02** Every event MUST come from a [typed definition](../terms/event-definition.md) whose payload passes its schema, and a [serialized envelope](../terms/event-envelope.md) above 256 KiB MUST be rejected with [`EventTooLargeError`](../terms/event-too-large-error.md).
- **outbox-task-queue.C-03** No domain code MAY access the [outbox or inbox tables](../terms/inbox-table.md) except through the exported services of [{{cap:S53}}](../capabilities/S53-events-projections.md); a CI check enforces this.
- **outbox-task-queue.C-04** The [relay](../terms/outbox-relay.md) MUST publish the envelope JSON keyed by [`aggregateId`](../terms/aggregate-id.md), with headers [`eventId`](../terms/event-id.md), `type`, `version`, [`traceparent` ↗](../sw-external-terms.md#traceparent), and MUST [keep event order per aggregate](../terms/per-aggregate-ordering.md).
- **outbox-task-queue.C-05** Publication MUST be [at least once](../terms/at-least-once-delivery.md): a crash between [send and mark](../terms/outbox-relay.md) MUST yield a duplicate with the same `eventId`, never a loss.
- **outbox-task-queue.C-06** The relay MUST claim rows with a [30 s lease](../terms/job-lease.md) and retry failures with [full-jitter backoff](../terms/jitter.md) (base 1 s, cap 60 s), [holding back later rows of the same aggregate](../terms/per-aggregate-ordering.md).
- **outbox-task-queue.C-07** A row MUST be [parked](../terms/parked-row.md) after 10 failed attempts, or at once on a [non-retryable broker error](../terms/non-retryable-job-error.md), and a parked row MUST NOT block its aggregate.
- **outbox-task-queue.C-08** A consumer MUST declare [`inbox`](../terms/inbox-table.md), [`versionGuard`](../terms/version-guard.md) or [`natural`](../terms/natural-idempotency.md), and MUST [commit offsets ↗](../sw-external-terms.md#kafka-offset-commit) only after its effects, so [redelivery](../terms/at-least-once-delivery.md) never loses an event.

## How the capabilities use it
- {{cap:S05}} writes one versioned product event in the same transaction as every committed product change (S05.R-20).
- {{cap:S10}} answers the payment webhook `200 {received: true}` after storing and queueing the event, never after processing (S10.R-26).
- {{cap:S13}} sends events only through the outbox, in the same transaction as the status change (S13.R-22).
- {{cap:S32}} builds its search index only from catalog events, which reach it through this backbone.
- {{cap:S53}} defines the event contract, the outbox, the relay, the consumers, replay and read-your-writes.

## Known gaps
- S01, S02 and S03 list this concept, but no line in their pages uses it. Their use of it is not stated.
- The concept title mentions tasks, but the facts describe only events. No task queue rule was given.
- Replay and read-your-writes are named in the S53 purpose, but no rule about them was given.
- The S32 line cites {{concept:projection-and-replay}} and does not name outbox rules, so the link to this concept is inferred.

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
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
<!-- used-by:end -->
