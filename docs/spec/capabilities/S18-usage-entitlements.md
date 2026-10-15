---
id: S18
title: Usage metering (late events, adjustments) and entitlement checks
kind: capability
status: draft
generated_at: 54c07320
depends_on: [S01, S03, S17, S49, S50, S52, S53, S54]
concepts: [transaction-runner, rate-limit-policy, job-scheduler-lease, projection-and-replay, problem-json-errors, tenant-shop-rbac]
models: []
scope:
  - packages/backend/libs/domains/billing/**
  - packages/contracts/src/billing/**
---
# S18 - Usage metering (late events, adjustments) and entitlement checks

## Purpose
Other capabilities ask billing what a customer's plan allows, never which plan it is, and report what a customer consumed. Usage above the plan's included amount is billed fairly even when the report arrives days late: no unit is billed twice, a late unit becomes one adjustment on a later invoice, an issued invoice is never edited, and a stale cache never hands out a feature the customer no longer pays for.

## Entry points
- `EntitlementsService.get|getMany|hasEntitlement|checkLimit|checkQuota|invalidate`: what a subject may do, from the live subscription or the free tier. [code: packages/backend/libs/domains/billing/application/entitlements.service.ts#EntitlementsService]
- `RequiresShopEntitlement(feature)`: the route guard, `403 entitlement_required {feature}`. [code: packages/backend/libs/domains/billing/application/entitlement.guard.ts#ShopEntitlementGuard]
- `GET /shops/:shopId/usage` (`shop.read`) and `GET /me/usage`: the monthly summary. [code: packages/backend/libs/domains/billing/api/usage.controller.ts#UsageController]
- Consumers of `usage.recorded`, `llm.call_completed` and `billing.subscription_status_changed`. [code: packages/backend/libs/domains/billing/infra/usage.consumers.ts#UsageRecordedConsumer]
- `UsageInvoiceLinesProvider.linesFor` and `UsageSettlementService.settle`, called by the renewal of S17. [code: packages/backend/libs/domains/billing/application/usage-lines.service.ts#UsageLinesService]
- Job `billing.usage-reconcile`, daily at 03:15 UTC. [code: packages/backend/libs/domains/billing/infra/usage-reconcile.job.ts#UsageReconcileJob]

## Rules
- **S18.R-01** An entitlement answer is the live subscription's plan entitlements (`TRIALING`, `ACTIVE`, `PAST_DUE`), otherwise the free tier of the subject type; keys outside the fixed list are rejected with `unknown_entitlement`. [proof: S18 AS-01, S18 AS-02, S18 AS-05] [code: packages/backend/libs/domains/billing/domain/entitlements.ts#hasEntitlement]
- **S18.R-02** A boolean key is present when `true`, a numeric key when greater than 0, a missing key is absent; `checkLimit` allows one more when `current < limit` and a missing limit is 0. [proof: S18 AS-03, S18 AS-04, S18 AS-07] [code: packages/backend/libs/domains/billing/domain/entitlements.ts#checkLimit]
- **S18.R-03** `getMany` answers up to 500 distinct ids with one batch call to the subscription basis and never loops per id. [proof: S18 AS-06] [code: packages/backend/libs/domains/billing/application/entitlements.service.ts#EntitlementsService]
- **S18.R-04** `checkQuota` compares the plan limit with the exact usage of the current UTC calendar month and rejects `usage_unavailable` when usage cannot be read. [proof: S18 AS-08] [code: packages/backend/libs/domains/billing/application/entitlements.service.ts#EntitlementsService]
- **S18.R-05** The guard runs after shop membership: a non-member gets `404`, a shop without the feature `403 entitlement_required` with `feature`, an unknown answer `503 entitlements_unavailable`; a route that has the guard without shop scoping, or with an unknown key, prevents start-up. [proof: S18 AS-09, S18 AS-10, S18 AS-11] [code: packages/backend/libs/domains/billing/application/entitlement.guard.ts#ShopEntitlementGuard]
- **S18.R-06** Answers are cached per subject type and id for 300 s with one load per process on a cold key; a failure of the cache store never changes an answer. [proof: S18 AS-12, S18 AS-13, S18 AS-20, S18 AS-21] [code: packages/backend/libs/domains/billing/infra/entitlement-cache.adapter.ts#EntitlementCacheAdapter]
- **S18.R-07** `invalidate` after a subscription change and the event consumer drop the entry; events are de-duplicated by event id, ordered by `subscriptionVersion` for one subscription, and a load that started before a newer invalidation never stores its result. [proof: S18 AS-14, S18 AS-15, S18 AS-16, S18 AS-17] [code: packages/backend/libs/domains/billing/infra/usage.consumers.ts#SubscriptionStatusConsumer]
- **S18.R-08** When a load fails, an entry up to 60 minutes old is served and counted, otherwise the call rejects `entitlements_unavailable`; an invalidation that cannot be done is reported and, in the consumer, redelivered. [proof: S18 AS-19, S18 AS-20] [code: packages/backend/libs/domains/billing/infra/entitlement-cache.adapter.ts#EntitlementCacheAdapter]
- **S18.R-09** An invalid event payload is dead-lettered with its reason and has no effect. [proof: S18 AS-18, S18 AS-28] [code: packages/backend/libs/domains/billing/domain/usage-validation.ts#validateUsageRecord]
- **S18.R-10** Usage enters only by events; each has an identity (`eventId`, or `llm:<aggregateId>`) that counts once however often, in whatever order or batch it is delivered; the ingestion instant is stored but never attributes usage to a period. [proof: S18 AS-22, S18 AS-23, S18 AS-24, S18 AS-25, S18 AS-26, S18 AS-31] [code: packages/backend/libs/domains/billing/infra/usage.consumers.ts#UsageRecordedConsumer]
- **S18.R-11** A usage record is valid when its metric matches the allowlist, its quantity is an integer from 1 to 1,000,000,000, its `ts` lies between 90 days ago and 5 minutes ahead and its subject is non-empty; a zero-token LLM call records nothing. [proof: S18 AS-27, S18 AS-28] [code: packages/backend/libs/domains/billing/domain/usage-validation.ts#validateUsageRecord]
- **S18.R-12** A failed write is not acknowledged and is redelivered; a poison message is dead-lettered without blocking its partition. [proof: S18 AS-29, S18 AS-30] [code: packages/backend/libs/domains/billing/infra/usage.consumers.ts#UsageRecordedConsumer]
- **S18.R-13** Overage is `ceil(max(0, used - included) / 1000) x rate` in integer minor units, rejecting results above the safe integer range. [proof: S18 AS-33, S18 AS-34] [code: packages/backend/libs/domains/billing/domain/usage-overage.ts#overageAmount]
- **S18.R-14** `linesFor` is read-only, answers within 5 s or rejects `usage_unavailable`, rejects invalid input, and returns lines in a fixed order plus the settlement plan. [proof: S18 AS-32, S18 AS-35, S18 AS-36, S18 AS-44, S18 AS-45] [code: packages/backend/libs/domains/billing/application/usage-lines.service.ts#UsageLinesService]
- **S18.R-15** A settlement ledger row per subscription, period and metric makes each unit billable once: late units become one adjustment priced with the period's snapshot, inside an already-billed block there is no line, and the sum of usage and adjustment amounts equals the price of the final total. [proof: S18 AS-38, S18 AS-39, S18 AS-40, S18 AS-41] [code: packages/backend/libs/domains/billing/domain/usage-adjustment.ts#planSettlement]
- **S18.R-16** `settle` runs in the invoice transaction of S17, is idempotent by invoice id and rejects a stale plan with `settlement_conflict`; of two racing settlements exactly one wins; an issued invoice is never modified. [proof: S18 AS-37, S18 AS-42, S18 AS-43] [code: packages/backend/libs/domains/billing/application/usage-settlement.service.ts#UsageSettlementService]
- **S18.R-17** A period is final 91 days after its end; a closed row is never queried or adjusted again. [proof: S18 AS-46] [code: packages/backend/libs/domains/billing/application/usage-settlement.service.ts#UsageSettlementService]
- **S18.R-18** A daily check reports ledger drift and never corrects it; two replicas run it once. [proof: S18 AS-47] [code: packages/backend/libs/domains/billing/application/usage-reconcile.service.ts#UsageReconcileService]
- **S18.R-19** The migration builds ledger rows for invoices of the last 90 days, repeatably. [proof: S18 AS-48]
- **S18.R-20** The usage summary lists every quota-mapped metric with used, limit and remaining for a month between 12 months ago and now; foreign shops answer `404`, the routes are limited to 60 a minute per subject and fail closed, a usage store failure is `503 usage_unavailable` with a generic detail. [proof: S18 AS-49, S18 AS-50, S18 AS-51, S18 AS-52, S18 AS-53, S18 AS-54, S18 AS-55] [code: packages/backend/libs/domains/billing/application/usage-read.service.ts#UsageReadService]
- **S18.R-21** The domain exports only contracted items, owns the ledger table and reads no other domain's tables. [proof: S18 AS-56]
- **S18.R-22** Usage and entitlement metrics exist and logs hold no payload or payment data. [proof: S18 AS-57] [code: packages/backend/libs/domains/billing/domain/metrics.ts#usageIngestedCounter]

## Behaviors
- **S18.B-01** Given shop `f` with 12,500 `api.calls` in April and 10,000 included at 50 per 1,000, then the renewal invoice carries a usage line of 150 for 2,500 units. [proof: S18 AS-32]
- **S18.B-02** Given April settled at 12,500 (150), when 800 late events arrive, then the June invoice carries one adjustment of 50 and April is settled at 13,300 (200). [proof: S18 AS-38]
- **S18.B-03** Given a shop on `pro`, then `hasEntitlement('SHOP', a, 'auctions')` is true and a shop on the free tier gets `403 entitlement_required` on a guarded route. [proof: S18 AS-03, S18 AS-09]

## Owns
- Tables: `UsageSettlement`.
- Jobs: `billing.usage-reconcile`.
- Rate-limit policies: `billing.usage-read.subject`.
- Metrics: `usage_events_ingested_total`, `usage_events_rejected_total`, `usage_events_ignored_total`, `entitlement_checks_total`, `entitlement_invalidations_total`, `entitlements_stale_served_total`, `entitlements_cache_errors_total`, `usage_settlement_conflicts_total`, `usage_ledger_drift`.

## Decisions
- Entitlements are read through S17's basis service and cached with the S52 toolkit; there is no second reader of the subscription tables.
- A ledger bound to quantities, not to time, makes late usage billable exactly once however many invoices later; the plan is checked by a conditional update on the quantity it started from.
- Usage in the last period of a cancelled subscription is not invoiced because S17 issues no invoice on cancellation.
- The free buyer tier carries `assistantTokensPerMonth: 200000` because the assistant relies on it.

## Retention
Usage events are kept in the analytical store; ledger rows are financial records kept at least 10 years.

## Known gaps
- Not proven by an automated test (listed in `specs/UNVERIFIED.md`, status `not run`): usage visible within 30 s in 99% of cases under load (SC-004), cached check latency percentile (SC-006), lock time of the ledger migration on a production-sized database (SC-009).
- Usage of a cancelled subscription's last period is not invoiced.
