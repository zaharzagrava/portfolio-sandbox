# HTTP contracts: S17 billing

Schemas live in `packages/contracts/src/billing/` (`planCatalogSchema`, `subscriptionSchema`, `changePreviewSchema`, `invoiceSchema`, `invoicePageSchema`, `changeResultSchema = {lines, subscription}`); controllers return mapper output only (`api/billing.mappers.ts`), never models. Errors are problem+json with the `code` shown. Money fields end in `Minor`; instants are ISO-8601 UTC with milliseconds. Shop routes use `ShopScoped(permission)` (404 non-member, 403 missing permission, `403 shop_suspended` / `409 shop_offboarding` on write permissions of closed shops); `/me` routes use the session user; admin routes `Firewall({roles: [ADMIN]})`.

| Route | Auth | Idempotency-Key | Rate-limit policy | Success | Errors (code) |
|---|---|---|---|---|---|
| `GET /plans` | anonymous | — | `billing.plans.ip` 120/min (fail-open) | 200 `planCatalogSchema`, `Cache-Control: public, s-maxage=300` | — |
| `POST /admin/billing/plans` | ADMIN | — | admin default | 201 plan | 400 `validation_failed`, 401, 403 `permission_denied`, 409 `plan_code_taken` |
| `POST /admin/billing/plans/:planId/prices` | ADMIN | — | admin default | 201 price (new `version`) | 400, 401, 403, 404 `plan_not_found` |
| `POST /admin/billing/prices/:priceId/retire` | ADMIN | — | admin default | 200 `{id, active: false}` | 401, 403, 404 `price_not_found`, 409 `price_already_retired` |
| `GET /shops/:shopId/subscription` | `shop.read` | — | read default | 200 `{subscription \| null, entitlements}` | 401, 403, 404 |
| `POST /shops/:shopId/subscription` | `billing.manage` | required | `billing.subscribe.subject` 10/h, fail-closed | 201 `subscriptionSchema` | 400, 401, 403, 404 `price_not_found`, 409 `already_subscribed` / `idempotency_in_flight`, 422 `payment_method_required` / `trial_not_available` / `plan_not_available_for_subject` / `sandbox_shop_not_billable` / `quantity_not_applicable` / `idempotency_key_required` / `idempotency_key_reuse`, 429, 503 |
| `POST /shops/:shopId/subscription/preview` | `billing.manage` | no | `billing.preview.subject` 60/min | 200 `changePreviewSchema` | as change, minus idempotency codes |
| `POST /shops/:shopId/subscription/change` | `billing.manage` | required | `billing.change.subject` 30/h | 200 `{lines, subscription}` | 400, 401, 403, 404 `no_active_subscription` / `price_not_found`, 409 `subscription_not_changeable` / `subscription_changed_concurrently` / `idempotency_in_flight`, 422 `billing_interval_change_not_supported` / `plan_not_available_for_subject` / `no_change_requested` / `quantity_not_applicable` / `idempotency_key_*`, 429 |
| `POST /shops/:shopId/subscription/cancel` `{immediately?: boolean}` | `billing.manage` | no | change policy | 200 `subscriptionSchema` | 400, 401, 403, 404 `no_active_subscription`, 409 `already_scheduled_for_cancellation` |
| `POST /shops/:shopId/subscription/resume` | `billing.manage` | no | change policy | 200 `subscriptionSchema` | 401, 403, 404, 409 `not_scheduled_for_cancellation` |
| `PUT /shops/:shopId/subscription/payment-method` `{paymentMethodRef}` | `billing.manage` | no | `billing.payment-method.subject` 5/h | 200 `subscriptionSchema` | 400, 401, 403, 404, 429 |
| `GET /shops/:shopId/invoices?limit&cursor` | `billing.manage` | — | read default | 200 `invoicePageSchema` `{items, nextCursor}` (no lines) | 400 `validation_failed` / `invalid_cursor`, 401, 403, 404 |
| `GET /shops/:shopId/invoices/:invoiceId` | `billing.manage` | — | read default | 200 `invoiceSchema` (lines, `status`, `attempts`, `nextAttemptAt`, `paidAt`) | 404 identical body for foreign/unknown |
| Buyer: `GET\|POST /me/subscription`, `POST /me/subscription/{preview,change,cancel,resume}`, `PUT /me/subscription/payment-method`, `GET /me/invoices`, `GET /me/invoices/:invoiceId` | session user | as shop routes | policies keyed by user | same shapes | same codes, no permission 403 |

Body rules: zod `.strict()` (unknown field ⇒ 400, `trialDays` named); `priceId` UUID; `quantity` integer 1–1000; `paymentMethodRef` `^pm_[A-Za-z0-9_]+$` ≤ 255; `limit` 1–100 default 20. The response never contains `paymentMethodRef`; it exposes `hasPaymentMethod`.

Order of checks on subscribe: authn → authz (`ShopScoped`) → body validation → idempotency claim → rate limit (counted per attempt) → eligibility (`ShopQueryService.getShopsByIds` before the transaction) → transaction.
