---
id: projection-and-replay
title: Projections, versions and replay
kind: concept
status: draft
defined_by: S53
---
# Projections, versions and replay
## Definition
A projection is a read model built only from the event log, never from another domain's table. Because the log is the source, any projection can be rebuilt by replaying it. Each consumer declares how it avoids double effects: `inbox`, `versionGuard` or `natural`. The guarantee to the capabilities that use it: each event takes effect once in effect, a late or repeated event never overwrites newer state, and a lost read model can be rebuilt from the log.

## Rules
- **[projection ↗](../sw-external-terms.md#projection)-and-replay.C-01** A projection MUST be built only from [events](../terms/event-definition.md); it MUST NOT read the source domain's table.
- **projection-and-replay.C-02** A projection MUST be rebuildable by [replaying the log](../terms/event-replay.md), so [the log](../terms/event-backbone.md) MUST hold every event a projection needs.
- **projection-and-replay.C-03** A [consumer](../terms/event-consumer.md) MUST declare [`inbox`](../terms/inbox-table.md), [`versionGuard`](../terms/version-guard.md) or [`natural`](../terms/natural-idempotency.md), and [group names](../terms/consumer-group.md) MUST be unique; otherwise startup fails with [`ConsumerDeclarationError`](../terms/consumer-declaration-error.md).
- **projection-and-replay.C-04** A [`versionGuard`](../terms/version-guard.md) consumer MUST apply an event only when its [`aggregateVersion`](../terms/aggregate-version.md) is higher than the stored one; equal counts [`duplicate`](../terms/consumer-outcomes.md), lower counts [`stale`](../terms/consumer-outcomes.md).
- **projection-and-replay.C-05** An [`inbox`](../terms/inbox-table.md) consumer MUST record `(consumer, eventId)` in the [effect's transaction ↗](../sw-external-terms.md#database-transaction), so [concurrent duplicates](../terms/consumer-deduplication-mode.md) yield one effect.
- **projection-and-replay.C-06** A consumer MUST [commit offsets ↗](../sw-external-terms.md#kafka-offset-commit) only after the effects, so a disconnect causes [redelivery](../terms/at-least-once-delivery.md) and never loss.
- **projection-and-replay.C-07** An event whose payload fails its schema MUST be [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue) with [`SCHEMA_INVALID`](../terms/schema-invalid.md) while the other events of the [batch](../terms/consumer-batch.md) apply.
- **projection-and-replay.C-08** An event type the consumer does not handle MUST be counted [`ignored`](../terms/consumer-outcomes.md), its [offset ↗](../sw-external-terms.md#kafka-offset-commit) MUST be committed, and it MUST NOT be [dead-lettered ↗](../sw-external-terms.md#dead-letter-queue).

## How the capabilities use it
- {{cap:S05}} is listed as using it, but no line of its page links it.
- {{cap:S32}} builds the search index as a read model only from catalog events and never reads the catalog's table.
- {{cap:S34}} records one basket per `order.paid` event through `OrderBasketsProjector`; it treats the basket store as a projection because replay can rebuild it.
- {{cap:S35}} is listed as using it, but no line of its page links it.
- {{cap:S53}} defines it: it provides the event contract, outbox, relay, consumer declarations, replay and read-your-writes.

## Known gaps
- S05 and S35 list this concept but no fact says what they rely on.
- The facts give no replay procedure (how to start a replay, which offsets it resets). S53's page was given only as its purpose and event rules.
- Read-your-writes is named in S53's purpose, but no rule describes it.

## Used by
<!-- used-by:start -->
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S14}} Double-entry ledger, balanced journals, hot-account sharding, balance read model, daily PSP reconciliation
- {{cap:S28}} Notification routing, preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S34}} "Bought together" recommendations: co-occurrence graph, normalisation, 2-hop cold start
- {{cap:S35}} Trending products: windowed approximate top-K per category
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
<!-- used-by:end -->
