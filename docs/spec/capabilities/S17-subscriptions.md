---
id: S17
title: Subscriptions - plans, versioned prices, state machine, billing run, charging and dunning, proration, credit
kind: capability
status: draft
generated_at: e85053d2
depends_on: [S01, S03, S13, S18, S28, S49, S50, S53, S54]
concepts: [outbox-task-queue, transaction-runner, idempotency-key, rate-limit-policy, job-scheduler-lease, projection-and-replay, problem-json-errors, tenant-shop-rbac]
models: []
scope:
  - packages/backend/libs/domains/billing/**
  - packages/contracts/src/billing/**
---
# S17 - Subscriptions - plans, versioned prices, state machine, billing run, charging and dunning, proration, credit

## Purpose
A shop subscribes to `starter`, `pro` or `enterprise`, and a buyer to Marketplace Plus. The customer is charged automatically at the end of every period, can change plan or seats in the middle of one and pays or is credited for exactly the days affected, and when a card fails is chased on a fixed schedule before access is withdrawn. Nothing charges a customer twice, skips a period, loses a credit, or lets an edited price rewrite the past.

## Entry points
- `GET /plans`: the public catalog, only active prices, in a fixed order. [code: packages/backend/libs/domains/billing/api/plans.controller.ts#PlansController]
- `POST /admin/billing/plans`, `POST /admin/billing/plans/:planId/prices`, `POST /admin/billing/prices/:priceId/retire`: the operator's catalog API (admin only). [code: packages/backend/libs/domains/billing/api/admin-billing.controller.ts#AdminBillingController]
- `GET|POST /shops/:shopId/subscription`, `POST .../preview`, `.../change`, `.../cancel`, `.../resume`, `PUT .../payment-method`, `GET .../invoices[/:invoiceId]`: a shop's subscription (`shop.read` to look, `billing.manage` to act). [code: packages/backend/libs/domains/billing/api/shop-subscription.controller.ts#ShopSubscriptionController]
- The same routes for a buyer under `/me`. [code: packages/backend/libs/domains/billing/api/buyer-subscription.controller.ts#BuyerSubscriptionController]
- Jobs `billing.run` (every 10 minutes, UTC, lease 600 s), `billing.charge-invoice`, `billing.resolve-attempt`, `billing.manual-attempt`. [code: packages/backend/libs/domains/billing/infra/billing.jobs.ts#BillingJobs]
- Consumer of `tenancy.shop_offboarding_started`, `tenancy.shop_offboarding_cancelled`, `tenancy.shop_deleted`. [code: packages/backend/libs/domains/billing/infra/tenancy.consumers.ts#TenancyLifecycleConsumer]
- Topic `billing.events`: `billing.subscription_status_changed`, `billing.subscription_plan_changed`, `billing.invoice_payment_failed`, `billing.invoice_paid`. [code: packages/backend/libs/domains/billing/application/events/billing-events.ts#SubscriptionStatusChanged]
- `SubscriptionBasisService.getLiveBasis`: the committed subscription that is live for entitlements, for S18. [code: packages/backend/libs/domains/billing/application/subscription-basis.service.ts#SubscriptionBasisService]

## Rules
- **S17.R-01** The catalog lists plans with only their active prices, ordered by plan code, interval, amount and id, with money in `...Minor` integers and no internal field; it is public and cacheable for 300 s. [proof: S17 AS-01] [code: packages/backend/libs/domains/billing/api/billing.mappers.ts#toCatalog]
- **S17.R-02** Only the platform admin writes the catalog; a plan code is unique, a shop plan is `starter`, `pro` or `enterprise`, entitlement keys come from a fixed list with non-negative values, and every body is strict. [proof: S17 AS-02, S17 AS-08] [code: packages/backend/libs/domains/billing/application/catalog.service.ts#CatalogService]
- **S17.R-03** A price is published as the next version of its plan and interval and is never edited: the store rejects any change to a commercial field or a reactivation, and accepts only `active` going from true to false; subscribers keep the price they bought, also when it is retired. [proof: S17 AS-03, S17 AS-04, S17 AS-05, S17 AS-07] [code: packages/backend/libs/domains/billing/infra/catalog.repository.ts#SequelizeCatalogRepository]
- **S17.R-04** Price bounds are 0 to 100,000,000 minor units, `EUR`, a trial of 0 to 90 days and a quantity of 1 to 1000; anything else is `400 validation_failed` and writes nothing. [proof: S17 AS-06, S17 AS-17] [code: packages/contracts/src/billing/catalog.ts#createPriceRequestSchema]
- **S17.R-05** Subscribing writes the subscription, its history row, the first invoice with lines, the charge request and the outbox events in one transaction, requires `Idempotency-Key`, and never calls the provider in the request; the cache of entitlements is forgotten after the commit. [proof: S17 AS-09, S17 AS-19] [code: packages/backend/libs/domains/billing/application/subscribe.service.ts#SubscribeService]
- **S17.R-06** A trial comes only from the price, is taken once per subject and needs a payment method; a payment method is also required whenever money is due; the client cannot choose a trial length; the billing anchor is the day the first paid period starts. [proof: S17 AS-11, S17 AS-12, S17 AS-13, S17 AS-14]
- **S17.R-07** Eligibility is checked before anything is written: the plan's audience matches the subject, a sandbox shop is refused, an unknown or retired price is `404 price_not_found`, and one live subscription per subject is enforced by the store (a losing concurrent subscribe answers `409 already_subscribed`; `UNPAID` counts as live). [proof: S17 AS-15, S17 AS-16]
- **S17.R-08** Shop routes need membership and `billing.manage` (`shop.read` to read), answer `404` for a non-member exactly as for an unknown shop, `403 shop_suspended` or `409 shop_offboarding` for a closed shop, and are limited per shop (subscribe 10, change 30, preview 60, payment method 5 an hour); the limiter being down refuses the request. [proof: S17 AS-18, S17 AS-20, S17 AS-57, S17 AS-69]
- **S17.R-09** The subscription status is a closed union with an explicit transition table; every other move is refused; `CANCELED` is terminal. [proof: S17 AS-21, S17 AS-25] [code: packages/backend/libs/domains/billing/domain/subscription-status.ts#transition]
- **S17.R-10** Every version bump is a version-guarded update that writes one append-only history row with the actor, and the status event, in the same transaction; concurrent moves leave a consistent chain and the store refuses to change history. [proof: S17 AS-23, S17 AS-24] [code: packages/backend/libs/domains/billing/application/subscription-transitions.service.ts#SubscriptionTransitions]
- **S17.R-11** Illegal calls answer `409` with a stable code and a missing subscription `404 no_active_subscription`. [proof: S17 AS-22, S17 AS-66]
- **S17.R-12** The billing run looks at most 500 due subscriptions, oldest period end first; each is locked and re-checked in its own transaction, advanced by one period, and invoiced once under a business key; two runs, a crash or a change at the boundary never double-bill or skip. [proof: S17 AS-26, S17 AS-27, S17 AS-28, S17 AS-35, S17 AS-38] [code: packages/backend/libs/domains/billing/application/renewal.service.ts#RenewalService]
- **S17.R-13** A finished trial becomes `ACTIVE` with its first invoice; a scheduled cancellation ends at the period end without an invoice; `PAST_DUE` and `UNPAID` subscriptions are not renewed; `UNPAID` for 30 days is cancelled. [proof: S17 AS-31, S17 AS-32, S17 AS-33, S17 AS-34]
- **S17.R-14** Usage lines come from S18 before the transaction opens; when they fail the subscription is deferred whole; one bad subscription is logged and counted and never stops the run; a stop signal ends the run between subscriptions. [proof: S17 AS-36, S17 AS-37, S17 AS-85]
- **S17.R-15** An issued invoice and its lines cannot be edited or deleted, even by a privileged session; only the status (along legal edges) and the attempt fields change. [proof: S17 AS-39] [code: packages/backend/libs/domains/billing/domain/invoice-status.ts#canMoveInvoice]
- **S17.R-16** Each attempt is claimed by one conditional update on the invoice, the provider is called once, outside any transaction, with a timeout, the invoice currency, metadata without `idempotencyKey` and the key `<invoiceId>:<attempt>`; the outcome is settled by the same guarded step whether it was heard or looked up. [proof: S17 AS-40, S17 AS-44, S17 AS-45] [code: packages/backend/libs/domains/billing/application/charge.service.ts#ChargeService]
- **S17.R-17** A decline moves `ACTIVE` to `PAST_DUE`; retries are due at the first failure plus 1, 3 and 7 days whatever time they ran; the fourth decline makes the invoice `UNCOLLECTIBLE` and the subscription `UNPAID`; payment recovers it only when no invoice remains owed. [proof: S17 AS-41, S17 AS-42, S17 AS-43, S17 AS-46, S17 AS-47] [code: packages/backend/libs/domains/billing/domain/dunning-schedule.ts#nextAttemptAt]
- **S17.R-18** An answer that is a timeout, an error or cannot be classified leaves the attempt claimed and unknown and is settled by looking the charge up by our reference (backoff with jitter, 60 minutes at most, then `no_provider_record`); a charge is never sent again for an attempt number already claimed. [proof: S17 AS-48, S17 AS-49, S17 AS-50, S17 AS-51, S17 AS-58] [code: packages/backend/libs/domains/billing/application/attempt-resolution.service.ts#AttemptResolutionService]
- **S17.R-19** A card needing the customer, or no payment method, is a definite failure with its own reason; an invoice of zero or less is created paid and never charged. [proof: S17 AS-52, S17 AS-53, S17 AS-54]
- **S17.R-20** Replacing the payment method stores the reference and, when the subscription is `PAST_DUE` or `UNPAID`, requests one extra attempt that does not shift the numbered schedule; a success recovers the subscription. [proof: S17 AS-55, S17 AS-56] [code: packages/backend/libs/domains/billing/application/payment-method.service.ts#PaymentMethodService]
- **S17.R-21** Preview and change run the same function at the same clock reading; the net `(new - old) x remaining / total` over whole UTC days is rounded once half away from zero and split by largest remainder; a net charge is a charged `PRORATION` invoice keyed by the new version, a net credit is a closed invoice plus a credit balance applied up to each later renewal's positive subtotal; of two concurrent changes exactly one wins. [proof: S17 AS-59, S17 AS-60, S17 AS-61, S17 AS-62, S17 AS-63, S17 AS-64, S17 AS-67, S17 AS-68, S17 AS-70] [code: packages/backend/libs/domains/billing/domain/proration.ts#prorate]
- **S17.R-22** A change while trialing swaps the price with no invoice. [proof: S17 AS-65]
- **S17.R-23** Cancel at period end keeps access, cancel now ends it and writes unpaid invoices off, resume withdraws a schedule; a shop's offboarding schedules the cancellation, its cancellation withdraws only that, and its deletion cancels now and erases the stored payment reference while invoices and histories stay; every consumer deduplicates on the event id in the transaction of its effect and dead-letters an invalid payload. [proof: S17 AS-71, S17 AS-72, S17 AS-73, S17 AS-74, S17 AS-75, S17 AS-76, S17 AS-77] [code: packages/backend/libs/domains/billing/application/tenancy-lifecycle.service.ts#TenancyLifecycleService]
- **S17.R-24** Reads put the subject in the predicate: invoice lists are keyset pages (default 20, at most 100) over every subscription of the subject, a foreign or unknown id is the same `404`, and the subscription DTO never carries the payment reference. [proof: S17 AS-78, S17 AS-79, S17 AS-80] [code: packages/backend/libs/domains/billing/application/invoice-query.service.ts#InvoiceQueryService]
- **S17.R-25** Plan tier events are announced for shops only, when the effective tier changes, with a per-shop version that never repeats or skips; all billing events are keyed by the subject and written through the outbox. [proof: S17 AS-81] [code: packages/backend/libs/domains/billing/application/plan-tier.service.ts#PlanTierService]
- **S17.R-26** The domain reads and writes only tables it owns, reaches shops only through `ShopQueryService`, exports no model, and registers each new table in the ownership registry. [proof: S17 AS-82] [code: packages/backend/libs/domains/billing/infra/shop-directory.adapter.ts#TenancyShopDirectoryAdapter]
- **S17.R-27** No payment-method reference appears in logs, responses, events or metric labels. [proof: S17 AS-83]
- **S17.R-28** The expand migration is idempotent and additive, converts open negative prorations into credit balance, and keeps old reads working. [proof: S17 AS-84]
- **S17.R-29** Each of the three deployable sides (HTTP, worker, consumers) starts in its real application. [proof: S17 AS-29, S17 AS-77, S17 AS-82]
- **S17.R-30** A shop's paid plan MUST apply only once money has been taken for it: from the subscribe until its first paid invoice (and while the first charge is declined, in `PAST_DUE` too) the shop is on the free tier for entitlements and for the announced tier; a trial, a free price and a buyer subscription are not held back. The settlement of the first paid invoice MUST announce `billing.subscription_status_changed {from: ACTIVE, status: ACTIVE}` and the tier change in the transaction that marks the invoice paid, and MUST NOT drop the entitlement cache by a direct call. The grace of `PAST_DUE` keeps the paid plan only for a subscription that has paid before. [proof: S17 G-13] [code: packages/backend/libs/domains/billing/application/subscription-transitions.service.ts#SubscriptionTransitions]
- **S17.R-31** With `PROVIDER_DOUBLES=enabled` (refused in production) the subscription charge goes to a scripted provider that answers by payment method: `pm_test_declined` declines, `pm_test_timeout` does not answer in time, any other reference succeeds; the same idempotency key never charges twice. [proof: S17 G-17] [code: packages/backend/libs/domains/billing/infra/scripted-billing-transport.ts#ScriptedBillingTransport]

## Behaviors
- **S17.B-01** Given shop `a` on `pro` for three seats at 2026-04-10T12:00:00Z, when Ann subscribes with `pm_ok`, then the response is `ACTIVE` with an open invoice of 29700 and the provider has not been called. [proof: S17 AS-09]
- **S17.B-02** Given `starter` in a 30-day period, when the shop upgrades to `pro` halfway, then the credit is -950, the charge 4950 and 4000 is due now, exactly what the preview showed. [proof: S17 AS-59, S17 AS-60]
- **S17.B-03** Given a card that declines on 2026-04-10T12:00:10Z, then retries are due on 04-11, 04-13 and 04-17 at 12:00:10 and after the fourth decline the subscription is `UNPAID`. [proof: S17 AS-42]
- **S17.B-04** Given a provider that never answers, then the invoice stays open, the subscription stays `ACTIVE`, and the lookup finds the charge and pays the invoice without a second charge. [proof: S17 AS-48, S17 AS-49]
- **S17.B-05** Given a downgrade worth 4000 of credit, when the next renewals run, then they use 1900, 1900 and 200 of it and the balance is never negative. [proof: S17 AS-61]
- **S17.B-06** Given a monthly subscription started on 31 January, then its periods end on 28 February, 31 March, 30 April and 31 May. [proof: S17 AS-30]
- **S17.B-07** Given a shop being deleted, then its subscription is cancelled, the stored payment reference erased and its invoices untouched. [proof: S17 AS-76]

## Owns
- Tables: `Plan`, `Price`, `Subscription`, `Invoice`, `InvoiceLine`, `SubscriptionTransition`, `InvoiceTransition`, `SubjectPlanState`.
- Events: `billing.subscription_status_changed`, `billing.subscription_plan_changed` (registered by tenancy, produced here), `billing.invoice_payment_failed`, `billing.invoice_paid` on topic `billing.events`.
- Jobs: `billing.run`, `billing.charge-invoice`, `billing.resolve-attempt`, `billing.manual-attempt`.
- Rate-limit policies: `billing.subscribe.subject`, `billing.change.subject`, `billing.preview.subject`, `billing.payment-method.subject`, `billing.plans.ip`.
- Metrics: `billing_renewals_total`, `billing_renewal_deferred_total`, `billing_renewal_failed_total`, `billing_charge_attempts_total`, `billing_unknown_attempts`, `billing_dunning_exhausted_total`, `billing_overdue_subscriptions`.

## Decisions
- Prices are versioned rows guarded by a store trigger, because an edited price would make every past invoice unprovable.
- The invoice row, not the job, is the truth about an attempt: a conditional claim on the row makes early, duplicate and late deliveries harmless, and an unknown outcome is looked up by our reference and never re-sent.
- Dunning offsets are a pure function of the first failure, so a late attempt does not push the schedule.
- Credit from a downgrade is a balance on the subscription applied at renewals, never a negative open invoice, so a credit larger than a renewal is not lost.
- Lock order is always the subscription row first, then its invoices, so a cancel and a settlement cannot deadlock.
- The plan-tier event is produced through the definition tenancy already registered, because the event registry refuses a second definition of one type.

## Retention
Invoices, lines and histories are financial records, kept at least 10 years and never deleted with a shop or user; only the stored payment-method reference is erased when a shop is deleted.

## Known gaps
- Not proven by an automated test (listed in `specs/UNVERIFIED.md`, status `not run`): 10,000 simulated renewals with crashes (SC-001), renewal within 15 minutes for 99% (SC-002), subscribe p95 under one second and the interaction time (SC-007), the lock time of the expand migration on a production-sized database (SC-010), the live provider's search latency after a charge, and the start of each application as its own process on an empty stack.
- Subscription revenue is not posted to the ledger; refunds and operator tools (void, force status) are not built; there is no billing screen.
- S18's usage lines come through a transitional adapter over `UsageService` until S18 ships its own provider.
