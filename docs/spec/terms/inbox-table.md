---
id: inbox-table
title: Outbox and inbox tables
kind: term
status: draft
aliases: [inbox, inbox tables, outbox table]
defined_for: outbox-task-queue
rules_hash: 22ebd2988fb6
---
# Outbox and inbox tables
## Definition
The outbox table holds events that are waiting to be published. The inbox table records which events a consumer has already applied, so a duplicate copy of an event that arrives again takes effect only once. Both tables belong to the capability that owns the outbox and the task queue. Domain code may reach them only through that capability's exported services, and a CI check enforces this. Design intent (not stated in the spec): this keeps [lease](job-lease.md) and [retry](job-retries.md) logic, along with the setting aside of rows that keep failing, in one place, and lets the owning capability change the tables freely.

## Example
S13 appends its payment event through S53's outbox service inside its transaction, which is allowed. If S10 code ran raw SQL against the outbox table, the CI check would fail the build.

## Known gaps
- The spec does not say the tables' names or columns, or which services S53 exports.
- The spec does not say how the CI check detects direct access.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-22, B-01
- [S14](../capabilities/S14-ledger-reconciliation.md): R-24
- [S53](../capabilities/S53-events-projections.md): R-08, R-16, R-19
- [outbox-task-queue](../concepts/outbox-task-queue.md): C-03
- [payment-lifecycle](../concepts/payment-lifecycle.md): C-07
- [transaction-runner](../concepts/transaction-runner.md): C-08
- [active-transaction](active-transaction.md)
- [amount-out-of-range](amount-out-of-range.md)
- [append-standalone](append-standalone.md)
- [at-least-once-delivery](at-least-once-delivery.md)
- [best-effort-push](best-effort-push.md)
- [consumer-deduplication-mode](consumer-deduplication-mode.md)
- [domain](domain.md)
- [event-definition](event-definition.md)
- [event-id](event-id.md)
- [event-too-large-error](event-too-large-error.md)
- [guarded-update](guarded-update.md)
- [inbox-item](inbox-item.md)
- [job-lease](job-lease.md)
- [job-retries](job-retries.md)
- [journal-posted-event](journal-posted-event.md)
- [ledger-events-topic](ledger-events-topic.md)
- [ledger-journal-posted-event](ledger-journal-posted-event.md)
- [ledger-reconciliation-issue-opened-event](ledger-reconciliation-issue-opened-event.md)
- [natural-idempotency](natural-idempotency.md)
- [no-active-transaction-error](no-active-transaction-error.md)
- [outbox-append-task](outbox-append-task.md)
- [outbox-append](outbox-append.md)
- [outbox-connector-configuration](outbox-connector-configuration.md)
- [outbox-purge-job](outbox-purge-job.md)
- [outbox-relay](outbox-relay.md)
- [outbox-rollback](outbox-rollback.md)
- [parked-row](parked-row.md)
- [payment-failed-event](payment-failed-event.md)
- [payment-status-event](payment-status-event.md)
- [payment-status-history](payment-status-history.md)
- [payment-status](payment-status.md)
- [products-events-topic](products-events-topic.md)
- [provider-secret](provider-secret.md)
- [relay-poller-mode](relay-poller-mode.md)
- [shop-created-event](shop-created-event.md)
- [shop-verification-changed-event](shop-verification-changed-event.md)
- [version-guard](version-guard.md)
<!-- used-by:end -->
