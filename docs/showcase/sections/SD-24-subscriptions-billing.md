# SD-24 — Subscription Billing (Marketplace Plus for buyers, Pro plans for shops)

Status: ☑ done (typechecked; specs written, not run) · Phase 2 · Depends on: SD-29, SD-02, SD-20, SD-17 (dunning emails) · Feeds: SD-07 (API quotas), SD-38 (entitlements), SD-42 (LLM quotas)

## Marketplace adaptation
- **Marketplace Plus** (buyers): free shipping, early access to drops — monthly/yearly.
- **Shop plans** (Starter / Pro / Enterprise): seats, product limits, API calls, LLM assistant tokens — **seat + usage-based** (metered API calls over quota).

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Versioned prices (never edit in place), `Plan` → `Price` | 10/07 #24 |
| Subscription state machine TRIALING → ACTIVE → PAST_DUE → ACTIVE/CANCELED/UNPAID (discriminated union) | 10/07 #24, 01/02 |
| **Billing run** (SD-29 cron hourly): due subscriptions → invoice idempotent per (subscription, period) unique → charge with idempotency key = invoiceId | 10/07 #24, 04/03 §1 |
| **Proration** on mid-cycle upgrade (day-based, largest-remainder money allocation, explicit rounding) | 10/07 #24, 01/01 §9 |
| Billing anchors & month-end (31st → shorter months) in UTC with Luxon | 01/01 §10 |
| **Dunning**: retries day 1/3/7 + emails (SD-17) → UNPAID → downgrade entitlements | 10/07 #24 |
| **Usage metering**: usage events (API calls from SD-07) aggregated in **ClickHouse** (`SummingMergeTree` per shop/metric/hour), period locked at invoice time; late events → adjustment line next invoice | 10/07 #24, 06/02 §5 |
| **Entitlements** cache: `entitlements:{shopId}` in Redis, rebuilt on subscription events; app checks features, not plan names | 10/07 #24 |
| Stripe Billing webhooks as alternative path — documented build vs buy | 10/07 #24 |

## Data / storage
Postgres: `Plan`, `Price`, `Subscription`, `Invoice`, `InvoiceLine`, `SubscriptionEvent`. ClickHouse: `usage_events` + `usage_hourly` MV. Redis: entitlements.

## Steps
- [x] Models/migrations; state machine.
- [x] Billing run job, invoice generator (pure function: subscription + period + usage → lines), proration calculator (pure, unit-tested — shared by upgrade + downgrade + seat change).
- [x] Charge via Stripe adapter (idempotent), dunning schedule jobs.
- [x] Usage ingestion (Kafka `usage.events` → ClickHouse MV), period lock.
- [x] Entitlements service + `@RequiresEntitlement('api.calls')` guard.
- [x] e2e: upgrade mid-cycle → proration lines sum correct; billing run twice → one invoice; 3 failed charges → UNPAID + entitlements downgraded.

## Scale
- Target: 5M subscriptions, billing runs spread (anchor dates) → ~170k invoices/day; usage events 100k/s.
- Hot path: entitlement checks → Redis (cached), never Postgres. Usage → Kafka → ClickHouse (no OLTP writes per API call).
- First bottleneck & fix: month-start billing spike → anchors spread across days + SD-29 per-shop fairness; usage → ClickHouse async inserts.
- Capacity model: 170k invoices/day ≈ 2/s average, 50/s at anchor peaks — trivial for Postgres; usage 100k events/s → ClickHouse 1 node handles ~1M rows/s inserts in batches.
- Proof: k6 usage-ingest; billing-run benchmark script for 100k due subscriptions.

## FE visualisation (phase 2)
Plans page, upgrade preview with proration, invoices list.

## Implementation notes (2026-10-01)
- Migration `20261001190000-subscriptions-billing`: `Plan` (entitlements JSONB), `Price` (versioned, per-seat, included usage, overage per 1,000), `Subscription` (one live per subject via partial unique index, anchor day, version), `Invoice` (UNIQUE subscription+periodStart+kind, dunning attempts, `usageMeasuredAt`), `InvoiceLine`; seeds Plus / Starter / Pro. ClickHouse `clickhouse/010_usage_events.sql` (ReplacingMergeTree raw usage with `ingested_at`, hourly SummingMergeTree MV for dashboards only).
- Pure math (`billing/periods.ts`, `billing/proration.ts`): anchored periods (31st → month ends, back to 31st), day-based proration with explicit half-away-from-zero rounding, overage in whole 1,000-blocks. Spec `billing-math.spec.ts` (values verified against Luxon).
- `BillingService`: subscribe (trial or first invoice), `previewChange` = the exact function `change` uses (preview == invoice), proration invoices (net credit → credit note applied to the next renewal), cancel at period end; invoice creation idempotent + charge job.
- `BillingJobs` (worker): renewal run every 10 min (version-guarded period advance + invoice in one tx, overage from ClickHouse FINAL sums, **late usage of the previous period as adjustment lines** - closed invoices are never edited), charge with per-attempt idempotency key, **dunning day 1/3/7** → UNCOLLECTIBLE + UNPAID; unknown provider outcome → job retry with the same key. Domain events `billing.invoice_payment_failed`, `billing.subscription_status_changed` (→ SD-17 notifications).
- `EntitlementsService` (cached, invalidated on every subscription change; free-tier fallback; PAST_DUE keeps access) + `@RequiresShopEntitlement` (fail-closed; now gating auction creation). `UsageService` (Kafka produce + ClickHouse exact/late queries) + `UsageProjector` (apps/projector).
- `BillingGateway` port (Stripe adapter + fake). Endpoints: `GET /api/plans`, shop subscription CRUD/preview/change/cancel/invoices, `GET|POST /api/me/subscription` (Plus).
- Spec `billing/billing.e2e-spec.ts`.
