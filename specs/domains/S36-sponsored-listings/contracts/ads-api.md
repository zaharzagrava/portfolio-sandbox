# Contract: S36 HTTP API

Schemas live in `packages/contracts/src/marketing/ads.ts` (extends the existing `sponsoredSlotSchema` / `sponsoredSlotsResponseSchema`; the existing exports keep their shape — additive only). Every error is `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`, `requestId`, stable `code`); a `5xx` has a generic `detail`. Authenticated routes use `ShopScoped(permission)` of S03 (non-members of the shop get `404 shop_not_found`). Mutating campaign routes carry no `Idempotency-Key` requirement: they create no order, payment, booking, bid or ledger movement (V.6); a repeated create answers `409 campaign_already_exists`.

## Campaigns (`/shops/:shopId/ads/campaigns`)

| Route | Permission | Request | Success | Errors |
|---|---|---|---|---|
| `POST /shops/:shopId/ads/campaigns` | `shop.manage` | `createAdCampaignRequestSchema` `{productId: uuid, cpcMinor: int 1–10000, dailyBudgetMinor: int 100–10000000}` strict | `201 adCampaignSchema` | `400 validation_failed` (field named), `401`, `403 permission_denied`, `404 shop_not_found`, `404 product_not_found` (also another shop's product), `409 campaign_already_exists`, `422 budget_below_cpc`, `422 campaign_limit_reached`, `422 product_not_sponsorable` (archived, sandbox), `429 rate_limited`, `503 rate_limiter_unavailable` |
| `GET /shops/:shopId/ads/campaigns?status&limit&cursor` | `products.read` | `status` ∈ `ACTIVE\|PAUSED\|ENDED`, `limit` 1–100 (20), opaque `cursor` | `200 adCampaignPageSchema {items, nextCursor}` ordered `createdAt DESC, id DESC` | `400 validation_failed`, `400 invalid_cursor`, `401`, `404 shop_not_found` |
| `GET /shops/:shopId/ads/campaigns/:campaignId` | `products.read` | | `200 adCampaignDetailSchema` (`adCampaignSchema` + `billedTodayMinor`) | `401`, `404 campaign_not_found` |
| `POST …/:campaignId/pause`, `…/resume`, `…/end` | `shop.manage` | none | `200 adCampaignSchema` | `401`, `403`, `404 campaign_not_found`, `409 invalid_transition` (`from`, `action`), `409 product_unavailable` (resume), `409 shop_inactive` (resume), `429`, `503 rate_limiter_unavailable` |
| `GET …/:campaignId/billing?from&to&limit&cursor` | `payouts.read` | `from`,`to` ISO instants (default last 7 days), range ≤ 92 days, `limit` 1–100 (20) | `200 adBillingPageSchema` | `400 validation_failed` (`from` after `to`, range > 92 days), `400 invalid_cursor`, `401`, `403`, `404 campaign_not_found` |

`adCampaignSchema` = `{id, shopId, productId, category, cpcMinor, dailyBudgetMinor, currency: 'EUR', status, statusReason: 'seller'|'product_unavailable'|null, campaignVersion, createdAt, updatedAt}`.
`adBillingPageSchema` item = `{hour, state: 'PENDING'|'CHARGED', source: 'stream'|'reconciliation', clicks, billableClicks, cappedClicks, amountMinor, adjustments: {sequence, deltaClicks, deltaMinor, postedAt}[], netAmountMinor}`; `netAmountMinor = amountMinor + Σ deltaMinor` over posted adjustments. `billedTodayMinor` = Σ net of charges **posted** in the current UTC day (`CHARGED` runs + `POSTED` adjustments), never an estimate.

Rate limits (S50): writes `marketing.ads-write.shop` 60/min per shop, fail **closed**; reads `marketing.ads-read.shop` 300/min per shop, fail **open**. A denial answers `429 rate_limited` with `Retry-After` and the structured `RateLimit` / `RateLimit-Policy` headers; a fail-closed store outage answers `503 rate_limiter_unavailable` and writes nothing. There is no cost-weighted policy, so `422 rate_limit_cost_exceeded` does not occur.

## Serving

`GET /ads/sponsored?category&limit` — anonymous (`Firewall({anonymous: true})`, session optional), policy `marketing.ads-serve.ip` 120/min per address, fail open.
- `category`: `all` (default, every category) or `^[a-z0-9-]{1,40}$`; `limit` 1–3 (default 3). Otherwise `400 validation_failed`.
- `200 sponsoredSlotsResponseSchema {items: {campaignId, productId, shopId, title, priceMinor, currency, sponsored: true, clickUrl, expiresAt}[], generatedAt}`; `Cache-Control: private, no-store`; `clickUrl` = `/api/ads/click/<token>` (the global `/api` prefix); `expiresAt` = served time + 30 min.
- At most `limit` items, one per shop, ordered by CPC descending then `campaignId` ascending. The body carries no CPC, budget or viewer identifier.
- Degradation: spend counters unreadable within 100 ms → `200 {items: []}`; database unavailable → `503 service_unavailable`; limiter store down → served; 121st request in a minute → `429 rate_limited`.
- Viewer identity for the keyed hash: the session user if present, else the `X-Anonymous-Id` header, else the resolved client address (never stored in clear).

## Click

`GET /ads/click/:token` — anonymous, **no rate-limit policy** (`@RateLimitExempt()`), exempt from load shedding of the optional kind.
- Always `302` with `Cache-Control: no-store`. `Location` = `front/p/<productId>?ad=1` for a valid, unexpired token (also after pause/end of the campaign: the impression was served while eligible); `front/` for any invalid, forged, expired, oversized (> 2,048 chars) or malformed token. `front` is the configured `front_host` origin; the target is built only from it and the signed product id, so `?redirect=`, `?next=` and a spoofed `Host`/`X-Forwarded-Host` change nothing.
- `HEAD` and requests with `Sec-Purpose: prefetch` / `Purpose: prefetch` answer the same redirect but record nothing and leave the impression unconsumed.
- Never `4xx`, `5xx` or `429` caused by a downstream store; a click that cannot be vetted is recorded `valid 0 / filter_unavailable`.
- Client address: only the platform's trusted-proxy resolution (`trusted_proxies`); forged `CF-Connecting-IP` / `X-Forwarded-For` from an untrusted peer are ignored.
- The route is a `GET` that records a click: the accepted exception to V.5 (plan, Complexity Tracking).

## Error codes (stable, problem `code`)

`validation_failed` 400, `invalid_cursor` 400, `invalid_token` 401 (the platform's code for a missing or invalid access token), `permission_denied` 403, `shop_not_found` 404, `product_not_found` 404, `campaign_not_found` 404, `campaign_already_exists` 409, `invalid_transition` 409, `product_unavailable` 409, `shop_inactive` 409, `budget_below_cpc` 422, `campaign_limit_reached` 422, `product_not_sponsorable` 422, `rate_limited` 429, `rate_limiter_unavailable` 503, `service_unavailable` 503. They are registered in the problem catalogue (`ProblemCatalogModule`) like `LEDGER_PROBLEMS`.

## Breaking changes against today's code (additive consumers: none exist)

Create body fields `category`, `cpcCents`, `dailyBudgetCents` are gone; the create response is a DTO, not a row array; `GET /ads/sponsored` returns `{items, generatedAt}` instead of a bare array (the `viewer` field is gone); tokens in flight at deploy (≤ 30 min) redirect to `front/`. W02's sponsored slot is behind `STOREFRONT_ADS_ENABLED` (off) and keeps working because the old shape was never consumed (`sponsored-listing.spec.ts` stays `fixme`); the `front/p/<productId>?ad=1` redirect is served by W02's `/p/[productId]` (308, query kept).
