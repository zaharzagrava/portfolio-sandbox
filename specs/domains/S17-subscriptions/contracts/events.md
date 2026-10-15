# Event contracts: S17 billing

Aggregate `billing`, topic = event type, key `subjectId`, written through `outbox.append` in the transaction of the change (never after it). Definitions use `defineEvent(type, 'billing', 1, zodSchema)` in `application/events/billing-events.ts`; the schemas are re-exported from `packages/contracts/src/billing/events.ts`. Additive within v1 (V.7).

| Event | Payload | Emitted when | Consumers |
|---|---|---|---|
| `billing.subscription_status_changed` | `{subscriptionId, subjectType: 'USER'\|'SHOP', subjectId, status, from: string \| null, planCode, subscriptionVersion}` | every `SubscriptionTransition` row with `from ≠ to` (not for `cancel_scheduled` / `cancel_withdrawn`) | S18 (ignore a `subscriptionVersion` older than stored), S28 |
| `billing.subscription_plan_changed` | `{shopId, plan: 'STARTER'\|'PRO'\|'ENTERPRISE', version}` | shops only, when the effective tier changes (research R-10); `version` = `SubjectPlanState.planVersion` | S03 |
| `billing.invoice_payment_failed` | `{invoiceId, subscriptionId, subjectType: 'USER'\|'SHOP', subjectId, attempt, nextAttemptAt: string \| null, reason, totalMinor, currency}`; `reason` ∈ `card_declined`, `authentication_required`, `no_payment_method`, `no_provider_record`, provider code | every definite failure (attempt 1–4); `nextAttemptAt null` ⇒ access withdrawn | S28 |
| `billing.invoice_paid` | `{invoiceId, subscriptionId, subjectType, subjectId, kind, totalMinor, currency, periodStart, periodEnd, paidAt}` | each `→ PAID` of a charged invoice (zero or negative invoices created `PAID` emit nothing) | S28; S14 later |

Change from today (`billing-events.ts`): `InvoicePaymentFailed` gains `reason`, `totalMinor`, `currency`, and `subjectType` becomes the `USER|SHOP` enum (the S28 follow-up found `reason` missing and `invoice_paid` absent); `SubscriptionStatusChanged` gains `subscriptionId`, `from`, `planCode`, `subscriptionVersion`; `InvoicePaid` and `SubscriptionPlanChanged` are new. Fields are only added, so existing consumers keep working (grep at task time).

## Consumed

| Topic | Schema (zod) | Effect |
|---|---|---|
| `tenancy.shop_offboarding_started` | `{shopId: uuid, purgeAt}` + envelope | live subscription: `cancelAtPeriodEnd = true`, `cancelReason = 'shop_offboarding'`, `offboardingStartedAt = occurredAt`, history actor `event:<eventId>` |
| `tenancy.shop_offboarding_cancelled` | `{shopId: uuid}` | clears the flag only when `cancelReason = 'shop_offboarding'` and `occurredAt > offboardingStartedAt` |
| `tenancy.shop_deleted` | `{shopId: uuid}` | live ⇒ `CANCELED` (`shop_deleted`), `paymentMethodRef = NULL`; invoices and histories untouched |

Dedupe by inbox on `eventId` in the effect's own transaction; invalid payloads are dead-lettered without effect.
