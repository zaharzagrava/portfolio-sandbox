# HTTP contract: S08 integrations

Base `/api`. Schemas live in `packages/contracts` (written first, Phase 0) and are the single source for controllers, e2e parsing and W04. Errors are `application/problem+json` `{type,title,status,detail,instance,requestId,code,errors?:[{field,code}]}`. Guard order (S03): `401 → 404 shop_not_found → 403 permission_denied → status gate (403 shop_suspended / 409 shop_offboarding)`. Permission `integrations.manage` (OWNER, ADMIN) on every route except the two anonymous ones. Cross-tenant IDs → `404` with the body of a nonexistent ID. Unknown body fields → `400 validation_failed`.

| Route | Request | Success | Errors |
|---|---|---|---|
| `POST /shops/:shopId/integrations/shopify/install` | `integrationInstallRequestSchema {shopDomain}` | `200 integrationInstallResponseSchema {authorizeUrl, expiresAt}` | 400 validation_failed, 401, 403, 404 shop_not_found, 429 (`catalog-sync.integration-write.shop`) |
| `GET /integrations/shopify/callback` (anonymous, `skipThrottle`) | provider query (`code,hmac,shop,state,timestamp,host?`) | `302 {web}/dashboard/integrations?connected=<id>` | `400 invalid_oauth_callback` (identical body for every verification failure); `302 …?error=oauth_exchange_failed\|currency_mismatch\|store_already_connected\|integration_limit_reached` |
| `POST /shops/:shopId/integrations` | `wooConnectRequestSchema {provider:'woocommerce', storeUrl, consumerKey, consumerSecret}` | `201` new / `200` existing `integrationSchema` | 422 invalid_store_url / provider_credentials_rejected / currency_mismatch, 409 store_already_connected / integration_limit_reached, 503 provider_unavailable |
| `GET /shops/:shopId/integrations?limit&cursor` | limit 1–100 (default 20) | `integrationPageSchema {items,nextCursor}` | 400 validation_failed / invalid_cursor |
| `GET /shops/:shopId/integrations/:integrationId` | — | `integrationSchema {id,provider,externalShop,status,pausedReason,lastError,lastSyncAt,watermark,lagSeconds,linkedProducts,openQuarantine,openConflicts,breakerOpenUntil,credentialsSet,createdAt}` | 404 integration_not_found |
| `DELETE /shops/:shopId/integrations/:integrationId` | — | `204` (repeat `204`, no second event) | 404 |
| `POST …/:integrationId/pause` \| `/resume` | — | `200 integrationSchema` | 409 invalid_integration_transition |
| `POST …/:integrationId/sync` | `integrationSyncRequestSchema {mode:'incremental'\|'backfill'}` | `202 {enqueued:boolean, reason?:'breaker_open'}` | 409 invalid_integration_transition, 429 rate_limited (+`Retry-After`) |
| `POST …/:integrationId/reconcile` | — | `202 {enqueued}` | 409, 429 (1/hour) |
| `GET …/:integrationId/quarantine?status&limit&cursor` | | `quarantinePageSchema` | 400 |
| `POST …/quarantine/:quarantineId/retry` | — | `200 {outcome:'resolved'\|'still_invalid', item:quarantineItemSchema}` | 404 quarantine_not_found, 409 quarantine_not_open |
| `POST …/quarantine/:quarantineId/dismiss` | — | `200 quarantineItemSchema` | 404, 409 quarantine_not_open |
| `GET …/:integrationId/conflicts?status&limit&cursor` | | `conflictPageSchema` | 400 |
| `POST …/conflicts/:conflictId/dismiss` | — | `200 stockConflictSchema` | 404 conflict_not_found, 409 conflict_not_open |
| `GET …/:integrationId/reconciliations?limit&cursor` | | `reconciliationPageSchema` | 400 |
| `GET …/reconciliations/:runId` | | `reconciliationReportSchema` (counts, ≤1,000 findings, `truncated`, `previousRunId`) | 404 report_not_found |
| `POST /integrations/:integrationId/webhooks` (anonymous, raw body, `skipThrottle`) | provider body + headers | `200 {received:true}` | 401 invalid_webhook_signature / webhook_stale, 413, 429 (+`Retry-After`), 503 |

Webhook headers: Shopify `X-Shopify-Hmac-Sha256` (base64 HMAC of raw bytes with app secret), `X-Shopify-Topic`, `X-Shopify-Webhook-Id`, `X-Shopify-Triggered-At`; WooCommerce `X-WC-Webhook-Signature` (base64 HMAC with the per-integration secret), `X-WC-Webhook-Delivery-ID`, topic header. Form-encoded `webhook_id` ping → `200`, nothing enqueued.

Route-order note: `GET /integrations/shopify/callback` and `POST /integrations/:integrationId/webhooks` are anonymous and registered on a controller separate from the shop-scoped routes.

Removed: provider `fake`, the `credentials` body field, permission `shop.manage` on connect.

Rate-limit policies on routes: connect/install/pause/resume/disconnect `catalog-sync.integration-write.shop` (30/min per shop, fail closed); sync `catalog-sync.sync-now.integration` (1/min); backfill and reconcile (1/hour); webhook `catalog-sync.webhook.integration` and `.ip` (fail open).
