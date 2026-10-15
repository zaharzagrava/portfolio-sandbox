# Research: S17 — Subscriptions (domain `billing`)

Decisions taken while planning, with what was checked in the code. Every NEEDS CLARIFICATION of the Technical Context is resolved here; the product decisions are in [`questions.md`](questions.md) (accepted as written, no human edits found).

## R-1 Layering and module split (D-6, D-7, D-8, A25)

- **Decision**: `domain/` (pure: status table, periods, proration, allocation, dunning schedule, cursor, errors, ports as injection tokens), `application/` (use cases, `TransactionRunner.run`), `infra/` (Sequelize repositories with all SQL, provider adapter, job handlers, tenancy consumers). `BillingJobs` becomes a thin `@JobHandler` shell over `RenewalService`, `ChargeService`, `AttemptResolutionService`.
- **Three loaders, each bootable alone (L-018)**: `BillingModule` (apps/core: HTTP), `BillingWorkerModule` (apps/worker: jobs + schedule), `BillingConsumerModule` (tenancy-event consumers, loaded by the worker app next to the jobs; imports its own inbox, repositories and `JobsModule`). Each module lists its own providers; nothing relies on the monolith supplying them.
- **S18 stays put (A25, A28)**: `EntitlementsService`, `UsageService`, `ShopEntitlementGuard`, `UsageProjector`, `RequiresShopEntitlement` and their exports remain until S18 moves them (auctions and the assistant meter import them through the barrel). S17 only (a) stops exporting the five models, (b) stops exporting `UsageProjector` as a class (apps import the module; **kept in the barrel until S18 if `check:boundaries` shows a user**, see R-12), (c) adds `SubscriptionBasisService` and the `UsageInvoiceLinesProvider` token, with a transitional adapter over `UsageService` so the renewal no longer reaches into it.
- **Alternatives**: one fat module (rejected: the worker would pull controllers; L-018). Moving entitlements now (rejected: S18's scope, would break auctions/assistant).

## R-2 Transactions, outbox and jobs (III.2, IV.4, A4, A20)

- **Decision**: every write path uses `TransactionRunner.run` (`libs/infrastructure/context/transaction-runner.service.ts`). `outbox.append(event)` and `JobsService.enqueue(...)` are called inside the runner's callback so they join the ambient transaction (the documented IX.6 exception). Cache invalidation (`EntitlementsService.invalidate`) runs **after** the runner resolves, never inside.
- `grep sequelize.transaction libs/domains/billing` finds no direct site, so the S54 gate count for billing is 0 and must stay 0.
- **Verify at task time**: `JobsService.enqueue` joins the ambient transaction (S49 contract says so; T-task includes a test that a rolled-back subscribe leaves no job row).
- The 50× concurrency rows rely on conditional updates (`WHERE status = :from AND version = :v`) plus unique indexes, not on advisory locks, except the renewal claim (R-5).

## R-3 Attempt claim, provider call, settlement (A11, A13, FR-031–FR-033)

- **Decision**: three steps, only the middle one outside a transaction.
  1. **Claim** (one transaction): `UPDATE "Invoice" SET attempts = attempts + 1, "attemptStartedAt" = :now WHERE id = :id AND status = 'OPEN' AND "attemptStartedAt" IS NULL AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= :now) AND total > 0 RETURNING …`; 0 rows ⇒ return without effect (early, duplicate, finished). The job `billing.charge-invoice` keyed `invoice-charge:<invoiceId>:<attempt>` is only a trigger; the invoice row is the truth.
  2. **Provider call**: `BillingGateway.charge` with an 8 s timeout, amount, `EUR`, metadata `{kind, invoiceId, subscriptionId, attempt}` and key `<invoiceId>:<attempt>` (`:manual:<k>` for manual attempts).
  3. **Settle** (one transaction): `UPDATE … WHERE id = :id AND attempts = :n AND "attemptStartedAt" IS NOT NULL AND status = 'OPEN'`; the result classification decides paid / declined / unknown. A process killed between 1 and 3 leaves `attemptStartedAt` set and no result ⇒ the reaper path (R-4) marks it unknown and schedules resolution (AS-85).
- **Unknown** keeps `attemptStartedAt`, sets `attemptUnknown = true`, does not advance the numbered schedule and enqueues `billing.resolve-attempt` at `+30 s` (then exponential backoff, full jitter, cap 15 min, using the `libs/infrastructure/jobs/backoff.ts` helper).
- **Stale claims**: a claim older than `charge.claimTimeoutMs` (default 60 s, above the 8 s call timeout) whose settle never ran is turned into an unknown attempt by `billing.resolve-attempt`; there is no path that re-sends a charge for an attempt number already claimed.
- **Alternatives**: row lock held across the provider call (rejected: holds a connection for the call, III.3); relying on provider idempotency alone (rejected: it protects the PSP, not our `attempts` counter and events).

## R-4 Provider lookup and classification (A13, A14, A27)

- **Facts found**: `StripeService.createPaymentIntent` already takes `currency`, a timeout, `metadata` and `maxNetworkRetries: 0` and has no breaker or load-test branch (S13 done). `findPaymentIntentByIdempotencyKey` searches `metadata['idempotencyKey']`, which billing's metadata does not carry, and it has no timeout. `is_load_test` branches remain in other methods of `stripe.service.ts` (lines 316, 346: not billing's methods).
- **Decision**: the adapter (`infra/stripe-billing-gateway.ts`, anti-corruption, IV.8) adds a lookup `findCharge(invoiceId, attemptRef)` using a new lib method `StripeService.findPaymentIntentByMetadataPair(pairs, timeoutMs)` (query `metadata['invoiceId']:'…' AND metadata['attempt']:'…'`, `attempt` = `1`…`4` or `manual:<k>`). The metadata object stays exactly `{kind, invoiceId, subscriptionId, attempt}` so it never carries `idempotencyKey` (S10's order webhook keys on that field; see R-9).
- Classification (pure function in `domain/charge-outcome.ts`, table-tested): intent `succeeded` ⇒ `succeeded`; `StripeCardError` / `requires_payment_method` ⇒ `declined` (reason = provider decline code or `card_declined`); `requires_action` / `authentication_required` ⇒ `authentication_required`; timeout, connection error, `5xx`, unknown status, invalid body ⇒ `unknown` (reuses `isUnknownOutcome` and adds body validation). Never `succeeded` unless the status string is exactly `succeeded`.
- **Risk accepted**: provider search is eventually consistent; an immediate lookup can miss a just-created charge. The 60-minute rule (FR-033) absorbs it: not found before 60 minutes stays unknown; after 60 minutes `no_provider_record` is declared. A late-appearing charge after that is the documented residual (key `<invoiceId>:<attempt>` is spent; the next numbered attempt uses a new key). It is called out in `quickstart.md` Ops artifacts, not hidden.
- **Test double**: the provider double sits at the HTTP edge of the Stripe client (`test/fakes/`), supports create, search and the `pm_*` behaviours of DS-1.

## R-5 Billing run claim (A8, FR-022)

- **Decision**: `billing.run` (cron `*/10 * * * *`, zone `UTC`, lease 600 s) loops: (1) select up to 500 due ids `ORDER BY "currentPeriodEnd", id FOR UPDATE SKIP LOCKED` in a short claim transaction that returns ids only (no long-held locks); (2) for each id, outside any transaction, fetch usage lines (5 s cap) through `UsageInvoiceLinesProvider`; (3) a per-subscription transaction re-reads the row `FOR UPDATE`, rechecks due-ness and `version`, builds the invoice(s), advances the period, history, outbox, charge job. Two overlapping runs are safe by the recheck + unique business key, not by the first claim alone (the claim only reduces contention).
- A run stops claiming when the shutdown registry signals (FR-059) and between subscriptions checks the job's stop signal.
- "Now" comes from `CLOCK` once per run and is passed down; usage `measuredAt` is that instant.
- **Overdue gauge** (`billing_overdue_subscriptions`): one count query per run end.

## R-6 Money, periods, proration (A16, FR-041–FR-042)

- **Decision**: all money in `bigint`-safe JS integers (bounds make 100,000,000 × 1000 × 365 < 2^53 safe; asserted with `Number.isSafeInteger` at the boundary), store `BIGINT`, parsed with a strict helper (`domain/money.ts`) instead of `Number(...)` on raw rows. No float division.
- Day counts: `utcDate(end) − utcDate(start)` in days from `Date.UTC(y, m, d)`; `remaining = clamp(utcDate(end) − utcDate(changeAt), 0, total)`.
- Net: `numerator = (new − old) × remaining`, `net = roundHalfAwayFromZero(numerator / total)` with integer math (`BigInt` for the intermediate when `|numerator| > 2^53`, which the bounds exclude but the type guards); credit/charge split by largest remainder over the exact shares (`domain/allocation.ts`), ties to the credit line, zero lines omitted.
- Anchors: `nextPeriodEnd(start, interval, anchorDay)` clamps the anchor to the month length (`Date.UTC` with `0`-day trick), computed in UTC independent of `TZ` (test runs with `TZ=America/Los_Angeles` and `Asia/Kolkata`).
- Dunning schedule: `dunningDueAt(firstFailedAt, attempt)` ⇒ `+1/+3/+7` days (`86_400_000` ms multiples, UTC, no DST), `null` after attempt 4.

## R-7 Idempotency, rate limits (FR-007, FR-014, FR-038)

- **Decision**: `@Idempotent()` (`libs/infrastructure/idempotency`) on subscribe and change for both subjects; `IdempotencyModule` imported by `BillingModule`. `@RateLimit` policies declared in `rate-limit-policies.ts` via `definePolicies`: `billing.subscribe.subject` 10/h, `billing.change.subject` 30/h, `billing.preview.subject` 60/min, `billing.payment-method.subject` 5/h, `billing.plans.ip` 120/min (fail-open), the rest fail closed. Subject key for shop routes is the shop, for `/me` the user. Subscribe attempts are counted per attempt, including refusals (AS-20 counts "attempts").
- `GET /plans` also gets `Cache-Control: public, s-maxage=300` and the `billing.plans.ip` policy (today it skips throttling entirely, A21).

## R-8 Tenancy consumers (A19, FR-048, FR-049)

- **Decision**: one `Projector`-framework consumer (`libs/infrastructure/projections`, as `catalog/infra/shop-consumers.ts` does) for `tenancy.shop_offboarding_started`, `…_cancelled`, `shop_deleted`, using the inbox claim for dedupe (`idempotency = 'inbox'`), zod payload validation, dead-letter on invalid. Event definitions are imported from `@app/domains/tenancy` (`ShopDeleted` exists; the offboarding events are checked at T-task and imported if exported, otherwise declared locally with the same topic and flagged in the sibling follow-ups).
- The ordering rule of AS-75 stores `offboardingStartedAt` on the subscription (column `offboardingStartedAt`), compared with the envelope `occurredAt`.

## R-9 Order webhook collision (A27, requires S10)

- Billing metadata never carries `idempotencyKey`, so today's S10 mapping (`metadata.idempotencyKey`) finds nothing for billing intents and ignores them by accident; the explicit `kind: "subscription_invoice"` ignore rule is S10's change. Recorded in `gaps.md` § Sibling-spec follow-ups. S17 proves its side: the metadata contains `kind` and not `idempotencyKey` (AS-40).

## R-10 Plan tier counter (FR-020, S03 follow-up)

- **Decision**: table `SubjectPlanState {subjectType, subjectId, tier, planVersion}`. Inside the transaction that changes the effective tier: `INSERT … ON CONFLICT (subjectType, subjectId) DO UPDATE SET tier = :new, "planVersion" = "SubjectPlanState"."planVersion" + 1 WHERE "SubjectPlanState".tier <> :new RETURNING "planVersion"`; no returned row ⇒ tier unchanged ⇒ no event. This makes versions consecutive under concurrency (row lock on the upsert) and survives across subscriptions. First subscribe to `starter` for a shop with no state row: the base tier is `STARTER` (matches S03's default), so the first row is created with `planVersion 1` and tier `STARTER` only when the new tier differs from the implicit `STARTER`; AS-81's sequence `PRO v1, STARTER v2, PRO v3` and AS-11's `STARTER v1` both hold if the implicit prior state is "no row" and any first insert emits version 1 (AS-11: trial on `starter` emits `{plan: STARTER, version: 1}`). Rule: a missing row counts as "unannounced", the first write always emits.
- Effective tier = live plan code mapped to tier in `TRIALING|ACTIVE|PAST_DUE`, else `STARTER`.

## R-11 Migration (A2, A6, A10, A22, A23, FR-058)

- Two migrations: `…-billing-s17-expand.js` (additive; `SET lock_timeout`, idempotent `IF NOT EXISTS`, data conversion in bounded batches, triggers, ownership registry rows) and `…-billing-s17-contract.js` (drops the old unique `(subscriptionId, periodStart, kind)` once no code reads it, as its own step). The contract migration is a task at the end of the order of work and does not block the capability's tests. See `data-model.md`.
- Seeds: `starter` seats 5, `pro` seats 25 (`UPDATE … WHERE code IN (...) AND entitlements->>'seats' = old value`, so an operator-edited value is not overwritten); `enterprise` is operator-created.

## R-12 Barrel and boundaries (D-7, D-8, A25, A28)

- `index.ts` after the change exports: `BillingModule`, `BillingWorkerModule`, `BillingConsumerModule` (if apps need it separately), `SubscriptionBasisService` + DTO type, `UsageInvoiceLinesProvider` token + type, event definitions (`SubscriptionStatusChanged`, `SubscriptionPlanChanged`, `InvoicePaymentFailed`, `InvoicePaid`), rate-limit policies, and (unchanged, S18's) `EntitlementsService`, `RequiresShopEntitlement`, `UsageService`, `UsageRecorded`, `QuotaKey`, `QuotaStatus`, `UsageProjector`. The five model exports go. `grep` for outside importers of the models finds none (checked by `check:boundaries` at T-task).

## R-13 Contracts package (A1)

- `packages/contracts/src/billing/{index,catalog,subscription,invoice,preview,events}.ts` with zod schemas `planCatalogSchema`, `subscriptionSchema`, `changePreviewSchema`, `invoiceSchema`, `invoicePageSchema` and the four event payload schemas. Controllers build DTOs by explicit mappers (`api/billing.mappers.ts`), never by returning models. S28's consumer-side assumptions (`contracts/events.md` of S28) switch to these schemas (S28's follow-up).

## R-14 Follow-ups from built specs (all are requirements here)

| From | Requirement | Where planned |
|---|---|---|
| S03 | Replace direct use of `ShopModel`, `ShopMembershipModel`, `MembershipService`, raw tenancy SQL in billing with `ShopAccessService`, `ShopQueryService`, `MembershipQueryService` | Current code uses `ShopScoped` only if the controller does; T-task greps billing for the four names and removes any; sandbox flag via `ShopQueryService.getShopsByIds` (C table) |
| S03 | Retest `payouts.read` (not billing), `sso.manage` (not billing), and `ShopScoped` closed-shop answers `403 shop_suspended` / `409 shop_offboarding` on write permissions | AS-18/AS-69/AS-74 e2e rows add one case: a write route (`billing.manage`) on a suspended and an offboarding shop answers those codes; `shop.read` reads still work |
| S03 | Emit `billing.subscription_plan_changed {shopId, plan, version}` with monotonic per-shop `version` | R-10, FR-020, AS-81 |
| S13 | Billing no longer calls a payments charge command; uses its own port over the Stripe lib with `currency`, no breaker, no load-test shortcut, `maxNetworkRetries: 0` | R-4; the old `StripeBillingGateway.charge` is rewritten; `Domain_CircuitBreakerOpenError` is unused (S13's to delete) |
| S13 | `refundPaymentIntent` replaced by `createRefund`/`listRefunds` | Billing never refunded; grep confirms no call (T-task) |
| S28 | Topic names and payloads in S28's `events.md` are assumptions; confirm with shipped schemas | `contracts/events.md` of this plan is the shipped shape; S28 follow-up bullet in `gaps.md` |
| S28 (T006) | `invoice_payment_failed` lacks `reason`, no `invoice_paid`; consumer needs `subjectType` in `USER|SHOP` | New payload with `reason`, `subjectType: 'USER'|'SHOP'` (enum), new `InvoicePaid` event (FR-039, FR-052) |
| S54 | Direct `sequelize.transaction` sites | None in billing today; none added |

## Addendum (implementation, 2026-10-15)

- **R-11 migration helper**: no per-step helper exists in the migration runner; the migrations open short transactions of their own with `queryInterface.sequelize.transaction` (S16's expand step does the same). They are not under `libs/domains`, so the S54 direct-site count of billing stays 0 (`grep -rn "sequelize.transaction" libs/domains/billing` finds nothing, and AS-82 greps the sources). Each statement group runs with `SET LOCAL lock_timeout = '5s'`; the data conversion runs in batches of 500 invoices, each its own transaction, selecting `FOR UPDATE SKIP LOCKED` so a re-run or a parallel run converts each invoice once.
- **R-4 provider search consistency**: the lookup treats "found but not final" (`processing`, an unknown status) as still unknown and throws, so the attempt stays unknown and is retried; "found nothing" becomes `no_provider_record` only 60 minutes after the attempt began. The live provider's actual search delay is not measured here (UNVERIFIED row).
- **Queues (L-002, L-020)**: jobs are rows in the `Job` table (S49), not SQS queues; `elasticmq.conf` needs nothing for billing.
- **Attempt reference**: `Invoice.attemptRef` (`1`..`4` or `manual:<k>`) records which attempt is claimed, added by `20261016000310-billing-s17-attempt-ref.js`.
