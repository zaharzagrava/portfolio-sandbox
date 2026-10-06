# SD-01 — Embeddable "Buy on Marketplace" Storefront Widget

Status: ☑ done (backend + loader; typechecked; spec written, not run) · Phase 5 · Depends on: SD-07 (site keys), SD-39, SD-28, edge-be

## Marketplace adaptation
Shops embed a product card / "Buy on Marketplace" button on **their own websites** (`<script src="https://cdn.mkt/widget/v1/loader.js" data-site-key="pk_...">`). Clicking opens our checkout in an isolated iframe. The shop can pass its logged-in customer identity.

## Patterns showcased (backend half; FE iframe app = phase 2)
| Pattern | Lesson |
|---|---|
| Publishable site keys `pk_` bound to **registered origins**; `Origin` validated per request | 10/04 #1 |
| Per-site-key **CSP `frame-ancestors`** header on embed pages (allowlisted shop domains), `frame-ancestors 'none'` on everything else | 05/01 §2, 10/04 #1 |
| **Identity handoff**: shop backend signs short-lived JWT (HS256 with its `sk_`) → widget exchanges for our in-memory widget token (no third-party cookies) | 10/04 #1 |
| CHIPS partitioned cookie option (`Partitioned; SameSite=None; Secure`) + CSRF protection for those endpoints | 05/01 §3 |
| Tiny loader (< 5 KB, IIFE, single global, async) served from edge with short TTL; versioned `/v1/`; kill switch per site key | 10/04 #1 |
| Widget config endpoint cached at the edge per site key | 10/04 #1 |
| `postMessage` contract documented (origin checks, explicit targetOrigin) | 10/04 #1 |

## Steps
- [x] `WidgetSite` model (shopId, pk, allowedOrigins, killSwitch).
- [x] `GET /widget/v1/config?key=`, `POST /widget/v1/identify` (verify shop-signed JWT), embed CSP middleware.
- [x] Loader script (plain TS → small bundle) in `packages/edge-be/src/widget/loader.ts` served by worker.
- [x] e2e: identify with token signed by wrong secret → 401; origin not registered → 403; embed page CSP lists exact origins.

## Scale
- Target: loader on 500M page views/day → CDN-only; config 50k RPS → edge cache; checkout traffic = normal checkout.
- Proof: k6 config endpoint at edge-local.

## Implementation notes (2026-10-01)
- **Schema:** migration `20261001340000-widget-sites` adds `WidgetSite` (publishable `pk_live_` key, exact allowed origins, sealed identity secret, featured products, theme, kill switch).
- **`WidgetService`:**
  - Exact origin matching (scheme + host + port, no suffix tricks); missing or unregistered Origin → 403; kill switch → 410.
  - Config: edge-cacheable `s-maxage=60` with `Vary: Origin` and an echoed origin (never `*`).
  - Identity hand-off: the shop BACKEND signs HS256 (`aud=marketplace-widget`, `iss=pk`, exp ≤ 5 min, `jti` single-use in Redis) → our 15-minute widget token, held in iframe memory (no third-party cookies). It is deliberately not auto-linked to marketplace accounts by email (account-takeover vector).
- **`GET /api/widget/v1/embed`:** the iframe document. It's the only route with `frame-ancestors <site origins>` (X-Frame-Options removed there); everything else keeps the global `frame-ancestors 'none'`.
- **Edge loader** (`packages/edge-be/src/widget-loader.ts`, served at `/widget/v1/loader.js`, about 2.5 KB):
  - IIFE, one global; no innerHTML with remote data.
  - Iframe checkout; `postMessage` with explicit target origin and origin + source checks; the shop page supplies identity via `MarketplaceWidget.identify`.
  - 5-minute CDN TTL.
- **Endpoints:** `POST /api/shops/:shopId/widget/sites` (pk returned, identity secret shown once), `PUT .../sites/:id/kill-switch`, `GET /api/widget/v1/config`, `POST /api/widget/v1/identify`, `GET /api/widget/v1/embed`.
- **Spec** `widget/widget.e2e-spec.ts` covers: origin rules, CORS/Vary, hand-off (valid / replay / wrong secret / foreign issuer / long expiry), embed CSP, kill switch.
